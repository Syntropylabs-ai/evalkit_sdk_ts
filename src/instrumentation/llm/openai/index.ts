import { SpanKind, SpanStatusCode, context as otelContext, trace } from "@opentelemetry/api";
import type { Span, Context as OtelContext } from "@opentelemetry/api";
import type { EvalKitClient } from "../../../core/client.js";
import { emitToolCalls, fromOpenAIChat } from "../_toolcalls.js";
import { safeBody } from "../_body.js";

type Messages = Array<{ role: string; content: string | null }>;
type ToolCall = {
  id: string;
  type: string;
  function: { name: string; arguments: string };
};
type ChatCompletion = {
  id: string;
  model: string;
  choices: Array<{
    message: { content: string | null; tool_calls?: ToolCall[] };
    finish_reason?: string;
  }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
    completion_tokens_details?: { reasoning_tokens?: number };
    prompt_tokens_details?: { cached_tokens?: number };
  };
};
type CreateParams = {
  model?: string;
  messages?: Messages;
  system?: string;
  temperature?: number;
  max_tokens?: number;
  top_p?: number;
  stream?: boolean;
  stream_options?: { include_usage?: boolean } | null;
  tools?: unknown[];
};
type Completions = { create: (...args: unknown[]) => Promise<unknown> };

let warnedMissingStreamUsage = false;

function warnMissingStreamUsage(): void {
  if (warnedMissingStreamUsage) return;
  warnedMissingStreamUsage = true;
  try {
    console.warn(
      '[evalkit] a streamed OpenAI chat completion ended without a usage chunk, so this span reports 0 input and ' +
        '0 output tokens and every cost report prices the call at $0 - the OpenAI API only sends the final usage ' +
        'chunk when the request sets stream_options: { include_usage: true }; add it to your ' +
        'chat.completions.create({ ... }) call to get real token counts for streamed calls (warned once per process)'
    );
  } catch {  }
}

function wrapOpenAIStream(stream: any, span: Span, startMs: number = Date.now(), warnOnZeroUsage: boolean = false): any {
  let content = '';
  let tokensIn = 0;
  let tokensOut = 0;
  let reasoningTokens = 0;
  let cacheReadTokens = 0;
  let ttftMs: number | undefined;
  let finished = false;

  function finish(error?: Error) {
    if (finished) return;
    finished = true;
    if (warnOnZeroUsage && !error && !tokensIn && !tokensOut) warnMissingStreamUsage();
    span.setAttributes({
      'evalkit.completion': content,
      'gen_ai.usage.input_tokens': tokensIn,
      'gen_ai.usage.output_tokens': tokensOut,
      'gen_ai.streaming': true,
      ...(reasoningTokens && { 'gen_ai.usage.reasoning_tokens': reasoningTokens }),
      ...(cacheReadTokens > 0 && { 'gen_ai.usage.cache_read_tokens': cacheReadTokens }),
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
                if (!result.done && result.value) {
                  const chunk = result.value;
                  const delta = chunk.choices?.[0]?.delta?.content;
                  if (delta) {
                    if (ttftMs === undefined) ttftMs = Date.now() - startMs;
                    content += delta;
                  }
                  if (chunk.usage) {
                    tokensIn = chunk.usage.prompt_tokens ?? 0;
                    tokensOut = chunk.usage.completion_tokens ?? 0;
                    reasoningTokens = chunk.usage.completion_tokens_details?.reasoning_tokens ?? 0;
                    cacheReadTokens = chunk.usage.prompt_tokens_details?.cached_tokens ?? 0;
                  }
                }
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

export function patchOpenAI(
  client: EvalKitClient,
  completions: Completions,
  parentCtx?: OtelContext,
  system: string = "openai"
): void {
  if ((completions.create as { __evalkit?: boolean }).__evalkit) return;

  const original = completions.create;

  completions.create = async function (this: unknown, ...args: unknown[]): Promise<unknown> {
    const params = args[0] as CreateParams;
    const ctx = parentCtx ?? otelContext.active();

    const span = client.tracer.startSpan(
      "chat.completions.create",
      {
        kind: SpanKind.CLIENT,
        attributes: {
          "evalkit.span_type": "llm_call",
          "gen_ai.system": system,
          "gen_ai.request.model": params.model ?? "unknown",
          ...(params.temperature != null && { "gen_ai.request.temperature": params.temperature }),
          ...(params.max_tokens != null && { "gen_ai.request.max_tokens": params.max_tokens }),
          ...(params.top_p != null && { "gen_ai.request.top_p": params.top_p }),
          "evalkit.prompt": messagesToText(params.messages ?? []),
        },
      },
      ctx
    );

    const reqBody = safeBody(params);
    if (reqBody) span.setAttribute("gen_ai.request.body", reqBody);

    const spanCtx = trace.setSpan(ctx, span);

    if (params?.stream) {
      const streamStartMs = Date.now();
      const warnOnZeroUsage = system === 'openai' && !params.stream_options?.include_usage;
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
      return wrapOpenAIStream(stream, span, streamStartMs, warnOnZeroUsage);
    }

    let result: ChatCompletion;
    try {
      result = (await otelContext.with(spanCtx, () => original.apply(this, args))) as ChatCompletion;
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      span.recordException(error);
      span.setStatus({ code: SpanStatusCode.ERROR, message: error.message });
      span.end();
      throw err;
    }

    const choice = result.choices?.[0];
    const completion = choice?.message.content ?? "";
    const reasoningTokens = result.usage?.completion_tokens_details?.reasoning_tokens ?? 0;
    const cacheReadTokens = result.usage?.prompt_tokens_details?.cached_tokens ?? 0;

    span.setAttributes({
      "gen_ai.response.model": result.model,
      "gen_ai.response.id": result.id,
      "gen_ai.usage.input_tokens": result.usage?.prompt_tokens ?? 0,
      "gen_ai.usage.output_tokens": result.usage?.completion_tokens ?? 0,
      "gen_ai.usage.total_tokens": result.usage?.total_tokens ?? 0,
      "gen_ai.response.finish_reasons": choice?.finish_reason ? [choice.finish_reason] : [],
      "evalkit.completion": completion,
      ...(reasoningTokens && { "gen_ai.usage.reasoning_tokens": reasoningTokens }),
      ...(cacheReadTokens && { "gen_ai.usage.cache_read_tokens": cacheReadTokens }),
    });

    const respBody = safeBody(result);
    if (respBody) span.setAttribute("gen_ai.response.body", respBody);

    emitToolCalls(client, span, fromOpenAIChat(result));

    span.setStatus({ code: SpanStatusCode.OK });
    span.end();
    return result;
  };

  (completions.create as { __evalkit?: boolean }).__evalkit = true;
}

function messagesToText(messages: Messages): string {
  return messages
    .map((m) => `${m.role}: ${m.content ?? ""}`)
    .join("\n");
}
