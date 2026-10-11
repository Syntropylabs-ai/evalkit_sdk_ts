import { SpanKind, SpanStatusCode, context as otelContext, trace } from "@opentelemetry/api";
import type { Span, Context as OtelContext } from "@opentelemetry/api";
import type { EvalKitClient } from "../../../core/client.js";
import { emitToolCalls, fromAnthropicBlocks } from "../_toolcalls.js";
import { safeBody } from "../_body.js";
import { toolAttrs } from "../_request.js";
import { messageContentText } from "../../../core/message-content.js";

type AnthropicMessages = Array<{ role: string; content: unknown }>;
type ContentBlock = { type: string; text?: string; thinking?: string; id?: string; name?: string; input?: unknown };
type Message = {
  id: string;
  model: string;
  content: ContentBlock[];
  stop_reason?: string;
  usage?: { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number };
};
type CreateParams = {
  model?: string;
  system?: string;
  messages?: AnthropicMessages;
  max_tokens?: number;
  temperature?: number;
  top_p?: number;
  stream?: boolean;
  tools?: unknown[];
};
type Messages = { create: (...args: unknown[]) => Promise<unknown> };

function extractThinking(content: ContentBlock[]): { thinkingText: string; hasRedactedThinking: boolean } {
  const thinkingText = content
    .filter((b) => b.type === "thinking")
    .map((b) => b.thinking ?? "")
    .join("");
  const hasRedactedThinking = content.some((b) => b.type === "redacted_thinking");
  return { thinkingText, hasRedactedThinking };
}

function wrapAnthropicStream(stream: any, span: Span, startMs: number = Date.now()): any {
  let content = '';
  let thinking = '';
  let hasRedactedThinking = false;
  let tokensIn = 0;
  let tokensOut = 0;
  let cacheReadTokens = 0;
  let cacheCreationTokens = 0;
  let ttftMs: number | undefined;
  let finished = false;

  function processEvent(event: any) {
    const type = event?.type;
    if (type === 'content_block_delta') {
      const delta = event.delta;
      if (delta?.type === 'text_delta' && delta.text) {
        if (ttftMs === undefined) ttftMs = Date.now() - startMs;
        content += delta.text;
      } else if (delta?.type === 'thinking_delta' && delta.thinking) {
        if (ttftMs === undefined) ttftMs = Date.now() - startMs;
        thinking += delta.thinking;
      }
    } else if (type === 'content_block_start') {
      if (event.content_block?.type === 'redacted_thinking') hasRedactedThinking = true;
    } else if (type === 'message_start') {
      cacheReadTokens = event.message?.usage?.cache_read_input_tokens ?? 0;
      cacheCreationTokens = event.message?.usage?.cache_creation_input_tokens ?? 0;

      tokensIn = (event.message?.usage?.input_tokens ?? 0) + cacheReadTokens + cacheCreationTokens;
    } else if (type === 'message_delta') {
      tokensOut = event.usage?.output_tokens ?? 0;
    }
  }

  function finish(error?: Error) {
    if (finished) return;
    finished = true;
    span.setAttributes({
      'evalkit.completion': content,
      'gen_ai.usage.input_tokens': tokensIn,
      'gen_ai.usage.output_tokens': tokensOut,
      ...(cacheReadTokens > 0 && { 'gen_ai.usage.cache_read_tokens': cacheReadTokens }),
      ...(cacheCreationTokens > 0 && { 'gen_ai.usage.cache_creation_tokens': cacheCreationTokens }),
      'gen_ai.streaming': true,
      ...(thinking && { 'gen_ai.response.thinking': thinking }),
      ...(hasRedactedThinking && { 'gen_ai.response.has_redacted_thinking': true }),
      ...(!error && ttftMs !== undefined && { 'gen_ai.server.time_to_first_token_ms': ttftMs }),
    });
    const body = safeBody({ text: content });
    if (body) span.setAttribute('gen_ai.response.body', body);
    if (error) {
      span.recordException(error);
      span.setStatus({ code: SpanStatusCode.ERROR, message: error.message });
    } else {
      span.setStatus({ code: SpanStatusCode.OK });
    }
    span.end();
  }

  return new Proxy(stream, {
    get(target: any, prop: string | symbol, receiver: any) {
      if (prop === Symbol.asyncIterator) {
        return function () {
          const iter = target[Symbol.asyncIterator]();
          return {
            async next() {
              try {
                const result = await iter.next();
                if (!result.done && result.value) processEvent(result.value);
                if (result.done) finish();
                return result;
              } catch (err: any) {
                finish(err instanceof Error ? err : new Error(String(err)));
                throw err;
              }
            },
            return() {
              finish();
              return iter.return?.() ?? Promise.resolve({ done: true, value: undefined });
            },
            throw(err?: any) {
              finish(err instanceof Error ? err : new Error(String(err)));
              return iter.throw?.(err) ?? Promise.reject(err);
            },
            [Symbol.asyncIterator]() { return this; },
          };
        };
      }
      const val = Reflect.get(target, prop, receiver);
      return typeof val === 'function' ? val.bind(target) : val;
    },
  });
}

export function patchAnthropic(
  client: EvalKitClient,
  messages: Messages,
  parentCtx?: OtelContext
): void {
  if ((messages.create as { __evalkit?: boolean }).__evalkit) return;

  const original = messages.create;

  messages.create = async function (this: unknown, ...args: unknown[]): Promise<unknown> {
    const params = args[0] as CreateParams;
    const ctx = parentCtx ?? otelContext.active();
    const promptText = buildPrompt(params.system, params.messages ?? []);

    const span = client.tracer.startSpan(
      "messages.create",
      {
        kind: SpanKind.CLIENT,
        attributes: {
          "evalkit.span_type": "llm_call",
          "gen_ai.system": "anthropic",
          "gen_ai.request.model": params.model ?? "unknown",
          ...(params.temperature != null && { "gen_ai.request.temperature": params.temperature }),
          ...(params.max_tokens != null && { "gen_ai.request.max_tokens": params.max_tokens }),
          ...(params.top_p != null && { "gen_ai.request.top_p": params.top_p }),
          ...toolAttrs(params.tools),
          "evalkit.prompt": promptText,
        },
      },
      ctx
    );

    const reqBody = safeBody(params);
    if (reqBody) span.setAttribute("gen_ai.request.body", reqBody);

    const spanCtx = trace.setSpan(ctx, span);

    if (params?.stream) {
      const streamStartMs = Date.now();
      let stream: unknown;
      try {
        stream = await otelContext.with(spanCtx, () => original.apply(this, args));
      } catch (err) {
        const error = err instanceof Error ? err : new Error(String(err));
        span.recordException(error);
        span.setStatus({ code: SpanStatusCode.ERROR, message: error.message });
        span.end();
        throw err;
      }
      return wrapAnthropicStream(stream, span, streamStartMs);
    }

    let result: Message;
    try {
      result = (await otelContext.with(spanCtx, () => original.apply(this, args))) as Message;
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      span.recordException(error);
      span.setStatus({ code: SpanStatusCode.ERROR, message: error.message });
      span.end();
      throw err;
    }

    const textContent = result.content
      .filter((b) => b.type === "text")
      .map((b) => b.text ?? "")
      .join("");
    const { thinkingText, hasRedactedThinking } = extractThinking(result.content);
    const cacheReadTokens = result.usage?.cache_read_input_tokens ?? 0;
    const cacheCreationTokens = result.usage?.cache_creation_input_tokens ?? 0;

    const totalInputTokens = (result.usage?.input_tokens ?? 0) + cacheReadTokens + cacheCreationTokens;

    span.setAttributes({
      "gen_ai.response.model": result.model,
      "gen_ai.response.id": result.id,
      "gen_ai.usage.input_tokens": totalInputTokens,
      "gen_ai.usage.output_tokens": result.usage?.output_tokens ?? 0,
      ...(cacheReadTokens && { "gen_ai.usage.cache_read_tokens": cacheReadTokens }),
      ...(cacheCreationTokens && { "gen_ai.usage.cache_creation_tokens": cacheCreationTokens }),
      "gen_ai.response.finish_reasons": result.stop_reason ? [result.stop_reason] : [],
      "evalkit.completion": textContent,
      ...(thinkingText && { "gen_ai.response.thinking": thinkingText }),
      ...(hasRedactedThinking && { "gen_ai.response.has_redacted_thinking": true }),
    });

    const respBody = safeBody(result);
    if (respBody) span.setAttribute("gen_ai.response.body", respBody);

    emitToolCalls(client, span, fromAnthropicBlocks(result.content));

    span.setStatus({ code: SpanStatusCode.OK });
    span.end();
    return result;
  };

  (messages.create as { __evalkit?: boolean }).__evalkit = true;
}

function buildPrompt(system: unknown, messages: AnthropicMessages): string {
  const parts: string[] = [];
  if (system) parts.push(`system: ${messageContentText(system)}`);
  parts.push(...messages.map((m) => `${m.role}: ${messageContentText(m.content)}`));
  return parts.join("\n");
}
