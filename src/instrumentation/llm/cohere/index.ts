import { SpanKind, SpanStatusCode, context as otelContext, trace } from "@opentelemetry/api";
import type { Context as OtelContext } from "@opentelemetry/api";
import type { EvalKitClient } from "../../../core/client.js";
import { safeBody } from "../_body.js";

type ChatParams = {
  model?: string;
  message?: string;
  chatHistory?: Array<{ role: string; message?: string }>;
  temperature?: number;
  maxTokens?: number;
  preamble?: string;
  stream?: boolean;
};
type ChatResponse = {
  text?: string;
  generationId?: string;
  finishReason?: string;
  meta?: { tokens?: { inputTokens?: number; outputTokens?: number } };
};
type CohereChat = { chat: (...args: unknown[]) => Promise<unknown> };

export function patchCohere(
  client: EvalKitClient,
  cohereClient: CohereChat,
  parentCtx?: OtelContext
): void {
  if ((cohereClient.chat as any).__evalkit) return;

  const original = cohereClient.chat;

  cohereClient.chat = async function (this: unknown, ...args: unknown[]): Promise<unknown> {
    const params = args[0] as ChatParams;

    if (params?.stream) return original.apply(this, args);

    const historyLines = params?.chatHistory?.map(
      (h) => `${h.role}: ${h.message ?? ''}`
    ) ?? [];
    const promptText = [
      params?.preamble ? `system: ${params.preamble}` : '',
      ...historyLines,
      `user: ${params?.message ?? ''}`,
    ].filter(Boolean).join('\n');

    const ctx = parentCtx ?? otelContext.active();
    const span = client.tracer.startSpan(
      'chat',
      {
        kind: SpanKind.CLIENT,
        attributes: {
          'evalkit.span_type': 'llm_call',
          'gen_ai.system': 'cohere',
          'gen_ai.request.model': params?.model ?? 'unknown',
          ...(params?.temperature != null && { 'gen_ai.request.temperature': params.temperature }),
          ...(params?.maxTokens != null && { 'gen_ai.request.max_tokens': params.maxTokens }),
          'evalkit.prompt': promptText,
        },
      },
      ctx
    );

    const reqBody = safeBody(params);
    if (reqBody) span.setAttribute('gen_ai.request.body', reqBody);

    const spanCtx = trace.setSpan(ctx, span);

    let result: ChatResponse;
    try {
      result = (await otelContext.with(spanCtx, () => original.apply(this, args))) as ChatResponse;
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      span.recordException(error);
      span.setStatus({ code: SpanStatusCode.ERROR, message: error.message });
      span.end();
      throw err;
    }

    span.setAttributes({
      'gen_ai.response.model': params?.model ?? 'unknown',
      'gen_ai.response.id': result.generationId ?? '',
      'gen_ai.usage.input_tokens': result.meta?.tokens?.inputTokens ?? 0,
      'gen_ai.usage.output_tokens': result.meta?.tokens?.outputTokens ?? 0,
      'gen_ai.response.finish_reasons': result.finishReason ? [result.finishReason] : [],
      'evalkit.completion': result.text ?? '',
    });

    const respBody = safeBody(result);
    if (respBody) span.setAttribute('gen_ai.response.body', respBody);

    span.setStatus({ code: SpanStatusCode.OK });
    span.end();
    return result;
  };

  (cohereClient.chat as any).__evalkit = true;
}
