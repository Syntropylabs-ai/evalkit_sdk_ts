import { SpanKind, SpanStatusCode, context as otelContext, trace } from "@opentelemetry/api";
import type { Context as OtelContext } from "@opentelemetry/api";
import type { EvalKitClient } from "../../../core/client.js";
import { patchAnthropic } from "../anthropic/index.js";

// ─── Anthropic on Vertex AI ────────────────────────────────────────────────
// AnthropicVertex from @anthropic-ai/sdk/vertex uses the same messages.create
// API surface as the direct Anthropic SDK. We reuse the same patcher.

type AnthropicMessages = { create: (...args: unknown[]) => Promise<unknown> };

export function patchAnthropicVertex(
  client: EvalKitClient,
  messages: AnthropicMessages,
  parentCtx?: OtelContext
): void {
  patchAnthropic(client, messages, parentCtx);
}

// ─── Google Cloud Vertex AI (generative-ai) ───────────────────────────────
// @google-cloud/vertexai: generativeModel.generateContent({ contents: [...] })

type VertexContent = { role?: string; parts: Array<{ text?: string }> };
type VertexRequest = { contents?: VertexContent[]; systemInstruction?: { parts: Array<{ text?: string }> } };
type VertexCandidate = { content?: { parts?: Array<{ text?: string }> }; finishReason?: string };
type VertexResponse = {
  response?: {
    candidates?: VertexCandidate[];
    usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number; totalTokenCount?: number };
  };
};
type GenerativeModel = {
  generateContent: (...args: unknown[]) => Promise<unknown>;
  model?: string;
};

export function patchVertexGenerativeModel(
  client: EvalKitClient,
  model: GenerativeModel,
  parentCtx?: OtelContext
): void {
  if ((model.generateContent as any).__evalkit) return;

  const original = model.generateContent;
  const modelName = model.model ?? 'unknown';

  model.generateContent = async function (this: unknown, ...args: unknown[]): Promise<unknown> {
    const req = args[0] as VertexRequest;
    const systemText = req?.systemInstruction?.parts?.map((p) => p.text ?? '').join('') ?? '';
    const promptLines = req?.contents?.map(
      (c) => `${c.role ?? 'user'}: ${c.parts.map((p) => p.text ?? '').join('')}`
    ) ?? [];
    const promptText = [systemText ? `system: ${systemText}` : '', ...promptLines]
      .filter(Boolean)
      .join('\n');

    const ctx = parentCtx ?? otelContext.active();
    const span = client.tracer.startSpan(
      'generateContent',
      {
        kind: SpanKind.CLIENT,
        attributes: {
          'evalkit.span_type': 'llm_call',
          'gen_ai.system': 'google-vertex',
          'gen_ai.request.model': modelName,
          'evalkit.prompt': promptText,
        },
      },
      ctx
    );

    const spanCtx = trace.setSpan(ctx, span);

    let result: VertexResponse;
    try {
      result = (await otelContext.with(spanCtx, () => original.apply(this, args))) as VertexResponse;
    } catch (err) {
      span.setStatus({ code: SpanStatusCode.ERROR, message: err instanceof Error ? err.message : String(err) });
      span.end();
      throw err;
    }

    const resp = result?.response;
    const firstCandidate = resp?.candidates?.[0];
    const completionText = firstCandidate?.content?.parts?.map((p) => p.text ?? '').join('') ?? '';

    span.setAttributes({
      'gen_ai.response.model': modelName,
      'gen_ai.usage.input_tokens': resp?.usageMetadata?.promptTokenCount ?? 0,
      'gen_ai.usage.output_tokens': resp?.usageMetadata?.candidatesTokenCount ?? 0,
      'gen_ai.usage.total_tokens': resp?.usageMetadata?.totalTokenCount ?? 0,
      'gen_ai.response.finish_reasons': firstCandidate?.finishReason ? [firstCandidate.finishReason] : [],
      'evalkit.completion': completionText,
    });

    span.setStatus({ code: SpanStatusCode.OK });
    span.end();
    return result;
  };

  (model.generateContent as any).__evalkit = true;
}
