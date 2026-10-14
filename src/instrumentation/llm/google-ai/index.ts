import { SpanKind, context as otelContext, trace } from "@opentelemetry/api";
import type { Span, Context as OtelContext } from "@opentelemetry/api";
import type { EvalKitClient } from "../../../core/client.js";
import { guarded, swallow } from "../../../core/guard.js";
import { claimPatch } from "../../_patched.js";
import { safeBody } from "../_body.js";
import { generativeModelRequestAttrs } from "../_request.js";
import { emitToolCalls, fromGoogleParts } from "../_toolcalls.js";
import { extractGoogleUsage, googleUsageAttributes } from "../_google-usage.js";
import { observeCall } from "../_api-promise.js";
import { candidateText, finishReasonsOf, recordGenerativeStream } from "../_generative-stream.js";
import type { GenerativeResponse } from "../_generative-stream.js";
import { endSpan, setAttributes } from "../_span.js";
import { claimFrameworkModelRun } from '../../../core/framework-model-call.js';

type Part = { text?: string; inlineData?: unknown };
type Content = { role?: string; parts?: Part[] };
type GenerateContentRequest = {
  contents?: Content[];
  systemInstruction?: Content;
};
type GenerativeModel = {
  generateContent?: (...args: unknown[]) => unknown;
  generateContentStream?: (...args: unknown[]) => unknown;
  model?: string;
};

export function generativePrompt(req: unknown): string {
  if (typeof req === 'string') return `user: ${req}`;
  if (Array.isArray(req)) {
    return req.map((p) => (typeof p === 'string' ? p : (p as Part)?.text ?? '')).filter(Boolean).join('\n');
  }
  const r = req as GenerateContentRequest;
  const systemText = r?.systemInstruction?.parts?.map((p) => p.text ?? '').join('') ?? '';
  const contentLines = r?.contents?.map(
    (c) => `${c.role ?? 'user'}: ${(c.parts ?? []).map((p) => p.text ?? '').join('')}`
  ) ?? [];
  return [systemText ? `system: ${systemText}` : '', ...contentLines]
    .filter(Boolean)
    .join('\n');
}

/** The whole reply of a generateContent call: `{ response }` for @google/generative-ai, the response itself elsewhere. */
export function recordGenerativeResult(client: EvalKitClient, result: unknown, span: Span, modelName: string): unknown {
  const resp = ((result as { response?: unknown })?.response ?? result) as GenerativeResponse;
  setAttributes(span, () => {
    const { completion, thinking } = candidateText(resp);
    return {
      'gen_ai.response.model': modelName,
      ...googleUsageAttributes(extractGoogleUsage(resp?.usageMetadata)),
      'gen_ai.response.finish_reasons': finishReasonsOf(resp),
      'evalkit.completion': completion,
      ...(thinking && { 'gen_ai.response.thinking': thinking }),
      'gen_ai.response.body': safeBody(result),
    };
  }, 'recording a Gemini reply');
  guarded('recording Gemini tool calls', () => emitToolCalls(client, span, fromGoogleParts(resp)), undefined);
  endSpan(span);
  return result;
}

export interface GenerativeModelOptions {
  system: string;
  parentCtx?: OtelContext;
}

/** Patches generateContent and generateContentStream of a GenerativeModel prototype or instance. */
export function patchGenerativeModel(client: EvalKitClient, model: GenerativeModel, options: GenerativeModelOptions): void {
  if (!model) return;
  for (const method of ['generateContent', 'generateContentStream'] as const) {
    const original = model[method];
    if (typeof original !== 'function' || (original as { __evalkit?: boolean }).__evalkit) continue;
    if (!claimPatch(model, method)) continue;
    const streaming = method === 'generateContentStream';

    const traced = function (this: GenerativeModel, ...args: unknown[]): unknown {
      const started = guarded('starting a Gemini span', () => {
        const req = args[0];
        const modelName = (this?.model ?? model.model ?? 'unknown') as string;
        const framework = claimFrameworkModelRun();
        const ctx = options.parentCtx ?? framework?.ctx ?? otelContext.active();
        const span = client.tracer.startSpan(
          method,
          {
            kind: SpanKind.CLIENT,
            attributes: {
              'evalkit.span_type': 'llm_call',
              'gen_ai.system': options.system,
              'gen_ai.request.model': modelName,
            },
          },
          ctx
        );
        if (framework) span.setAttributes(framework.attributes);
        setAttributes(span, () => ({
          ...generativeModelRequestAttrs(this ?? model, req),
          ...(streaming && { 'gen_ai.streaming': true }),
          'evalkit.prompt': generativePrompt(req),
          'gen_ai.request.body': safeBody(req),
        }), 'recording a Gemini request');
        return { span, ctx: trace.setSpan(ctx, span), modelName, startMs: Date.now() };
      }, undefined);
      if (!started) return original.apply(this, args);

      const { span } = started;
      return observeCall(
        () => otelContext.with(started.ctx, () => original.apply(this, args)),
        (result) => streaming
          ? recordGenerativeStream(client, result, span, started.startMs, started.modelName)
          : recordGenerativeResult(client, result, span, started.modelName),
        (err) => endSpan(span, err),
      );
    };

    (traced as { __evalkit?: boolean }).__evalkit = true;
    try {
      model[method] = traced;
    } catch (err) {
      swallow(`patching ${method}`, err);
    }
  }
}

export function patchGoogleAI(
  client: EvalKitClient,
  model: GenerativeModel,
  parentCtx?: OtelContext
): void {
  patchGenerativeModel(client, model, { system: 'google-ai', parentCtx });
}
