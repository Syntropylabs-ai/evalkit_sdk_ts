import { SpanStatusCode } from "@opentelemetry/api";
import { recordError } from '../../../core/exceptions.js';
import type { Span } from "@opentelemetry/api";
import { emitToolCalls } from "../_toolcalls.js";
import { safeBody } from "../_body.js";
import type { EvalKitClient } from "../../../core/client.js";
import type { BedrockResponseInfo } from "./_families.js";

export const BEDROCK_PROVIDER = 'bedrock';

export function toError(err: unknown): Error {
  return err instanceof Error ? err : new Error(String(err));
}

export function failSpan(span: Span, err: unknown): void {
  const error = toError(err);
  try {
    recordError(span, error, { escaped: true });
  } catch {  }
  endSpan(span);
}

export function endSpan(span: Span): void {
  try { span.end(); } catch {  }
}

export function applyResponse(
  client: EvalKitClient,
  span: Span,
  info: BedrockResponseInfo,
  fallbackModel: string,
  options?: { streaming?: boolean; ttftMs?: number; responseBody?: unknown; error?: Error },
): void {
  try {
    const cacheReadTokens = info.cacheReadTokens ?? 0;
    const cacheWriteTokens = info.cacheWriteTokens ?? 0;
    const inputTokens = (info.inputTokens ?? 0) + cacheReadTokens + cacheWriteTokens;
    const outputTokens = info.outputTokens ?? 0;
    const totalTokens = cacheReadTokens > 0 || cacheWriteTokens > 0
      ? inputTokens + outputTokens
      : info.totalTokens;

    const responseModel = info.responseModel ?? fallbackModel;

    span.setAttributes({
      ...(responseModel && { 'gen_ai.response.model': responseModel }),
      ...(info.responseId && { 'gen_ai.response.id': info.responseId }),
      'gen_ai.usage.input_tokens': inputTokens,
      'gen_ai.usage.output_tokens': outputTokens,
      ...(totalTokens !== undefined && { 'gen_ai.usage.total_tokens': totalTokens }),
      ...(cacheReadTokens > 0 && { 'gen_ai.usage.cache_read_tokens': cacheReadTokens }),
      ...(cacheWriteTokens > 0 && { 'gen_ai.usage.cache_creation_tokens': cacheWriteTokens }),
      'gen_ai.response.finish_reasons': info.finishReason ? [info.finishReason] : [],
      'evalkit.completion': info.completion ?? '',
      ...(info.thinking && { 'gen_ai.response.thinking': info.thinking }),
      ...(info.hasRedactedThinking && { 'gen_ai.response.has_redacted_thinking': true }),
      ...(options?.streaming && { 'gen_ai.streaming': true }),
      ...(options?.error === undefined && options?.ttftMs !== undefined && { 'gen_ai.server.time_to_first_token_ms': options.ttftMs }),
    });

    const body = safeBody(options?.responseBody ?? { text: info.completion ?? '' });
    if (body) span.setAttribute('gen_ai.response.body', body);

    if (info.toolCalls?.length) emitToolCalls(client, span, info.toolCalls);
  } catch {  }

  if (options?.error) {
    try {
      recordError(span, options.error, { escaped: true });
    } catch {  }
    return;
  }

  try { span.setStatus({ code: SpanStatusCode.OK }); } catch {  }
}
