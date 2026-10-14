import { SpanKind, context as otelContext, trace } from "@opentelemetry/api";
import type { Span, Context as OtelContext } from "@opentelemetry/api";
import type { EvalKitClient } from "../../../core/client.js";
import { guarded, swallow } from "../../../core/guard.js";
import { claimPatch } from "../../_patched.js";
import { emitToolCalls, fromOpenAIChat } from "../_toolcalls.js";
import { safeBody } from "../_body.js";
import { toolAttrs } from "../_request.js";
import { observeCall } from "../_api-promise.js";
import { FirstToken, StreamText, StreamToolCalls, observeStream } from "../_stream.js";
import { endSpan, setAttributes } from "../_span.js";
import { messageContentText } from "../../../core/message-content.js";
import { claimFrameworkModelRun } from "../../../core/framework-model-call.js";

type Messages = Array<{ role: string; content: unknown }>;
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
type Completions = { create: (...args: unknown[]) => unknown };

let warnedMissingStreamUsage = false;

function warnMissingStreamUsage(contentCaptured: boolean): void {
  if (warnedMissingStreamUsage) return;
  warnedMissingStreamUsage = true;
  const estimate = contentCaptured
    ? 'the trace service estimates its tokens from the prompt and completion text (about four characters a ' +
      'token) and marks the span evalkit.cost_estimated'
    : 'with content capture off there is no text to estimate its tokens from, so the call is recorded with no ' +
      'tokens and no cost';
  try {
    console.warn(
      `[evalkit] a streamed OpenAI chat completion ended without a usage chunk, so ${estimate}. The OpenAI API ` +
        'sends the usage chunk only when the request sets stream_options: { include_usage: true }; add it to ' +
        'your chat.completions.create({ ... }) call for exact token counts (warned once per process)'
    );
  } catch {  }
}

function recordChatStream(
  client: EvalKitClient,
  stream: unknown,
  span: Span,
  startMs: number,
  warnOnZeroUsage: boolean,
): unknown {
  const text = new StreamText();
  const tools = new StreamToolCalls();
  const first = new FirstToken(startMs);
  const finishReasons: string[] = [];
  let tokensIn = 0;
  let tokensOut = 0;
  let reasoningTokens = 0;
  let cacheReadTokens = 0;
  let responseId = '';
  let responseModel = '';

  const onChunk = (chunk: any): void => {
    for (const choice of chunk?.choices ?? []) {
      const index = typeof choice?.index === 'number' ? choice.index : 0;
      const delta = choice?.delta;
      if (delta) {
        if (index === 0 && text.append(delta.content)) first.mark();
        if (typeof delta.refusal === 'string' && delta.refusal) first.mark();
        for (const call of delta.tool_calls ?? []) {
          const entry = tools.entry(`${index}:${call?.index ?? 0}`);
          tools.describe(entry, call?.function?.name, call?.id);
          tools.appendArguments(entry, call?.function?.arguments);
        }
        if (delta.function_call) {
          const entry = tools.entry(`${index}:function_call`);
          tools.describe(entry, delta.function_call.name);
          tools.appendArguments(entry, delta.function_call.arguments);
        }
      }
      const reason = choice?.finish_reason;
      if (typeof reason === 'string' && reason && !finishReasons.includes(reason)) finishReasons.push(reason);
    }
    if (typeof chunk?.id === 'string' && chunk.id) responseId = chunk.id;
    if (typeof chunk?.model === 'string' && chunk.model) responseModel = chunk.model;
    if (chunk?.usage) {
      tokensIn = chunk.usage.prompt_tokens ?? 0;
      tokensOut = chunk.usage.completion_tokens ?? 0;
      reasoningTokens = chunk.usage.completion_tokens_details?.reasoning_tokens ?? 0;
      cacheReadTokens = chunk.usage.prompt_tokens_details?.cached_tokens ?? 0;
    }
  };

  const onEnd = (error?: Error): void => {
    if (warnOnZeroUsage && !error && !tokensIn && !tokensOut) {
      guarded('warning about stream usage', () => warnMissingStreamUsage(client.options.captureContent !== false), undefined);
    }
    const completion = text.toString();
    setAttributes(span, () => ({
      'evalkit.completion': completion,
      'gen_ai.usage.input_tokens': tokensIn,
      'gen_ai.usage.output_tokens': tokensOut,
      'gen_ai.streaming': true,
      ...(responseModel && { 'gen_ai.response.model': responseModel }),
      ...(responseId && { 'gen_ai.response.id': responseId }),
      ...(finishReasons.length > 0 && { 'gen_ai.response.finish_reasons': finishReasons }),
      ...(reasoningTokens && { 'gen_ai.usage.reasoning_tokens': reasoningTokens }),
      ...(cacheReadTokens > 0 && { 'gen_ai.usage.cache_read_tokens': cacheReadTokens }),
      ...first.attributes(error),
      'gen_ai.response.body': safeBody({ text: completion }),
    }), 'recording a streamed OpenAI reply');
    guarded('recording streamed tool calls', () => emitToolCalls(client, span, tools.calls()), undefined);
    endSpan(span, error);
  };

  return observeStream(stream, onChunk, onEnd);
}

function recordChatResult(client: EvalKitClient, result: ChatCompletion, span: Span): ChatCompletion {
  setAttributes(span, () => {
    const choice = result.choices?.[0];
    const reasoningTokens = result.usage?.completion_tokens_details?.reasoning_tokens ?? 0;
    const cacheReadTokens = result.usage?.prompt_tokens_details?.cached_tokens ?? 0;
    return {
      "gen_ai.response.model": result.model,
      "gen_ai.response.id": result.id,
      "gen_ai.usage.input_tokens": result.usage?.prompt_tokens ?? 0,
      "gen_ai.usage.output_tokens": result.usage?.completion_tokens ?? 0,
      "gen_ai.usage.total_tokens": result.usage?.total_tokens ?? 0,
      "gen_ai.response.finish_reasons": choice?.finish_reason ? [choice.finish_reason] : [],
      "evalkit.completion": choice?.message?.content ?? "",
      ...(reasoningTokens && { "gen_ai.usage.reasoning_tokens": reasoningTokens }),
      ...(cacheReadTokens && { "gen_ai.usage.cache_read_tokens": cacheReadTokens }),
      "gen_ai.response.body": safeBody(result),
    };
  }, "recording an OpenAI reply");
  guarded("recording tool calls", () => emitToolCalls(client, span, fromOpenAIChat(result)), undefined);
  endSpan(span);
  return result;
}

function startChatSpan(client: EvalKitClient, params: CreateParams, ctx: OtelContext, system: string): Span {
  const span = client.tracer.startSpan(
    "chat.completions.create",
    {
      kind: SpanKind.CLIENT,
      attributes: {
        "evalkit.span_type": "llm_call",
        "gen_ai.system": system,
        "gen_ai.request.model": params.model ?? "unknown",
      },
    },
    ctx
  );
  setAttributes(span, () => ({
    ...(params.temperature != null && { "gen_ai.request.temperature": params.temperature }),
    ...(params.max_tokens != null && { "gen_ai.request.max_tokens": params.max_tokens }),
    ...(params.top_p != null && { "gen_ai.request.top_p": params.top_p }),
    ...toolAttrs(params.tools),
    "evalkit.prompt": messagesToText(params.messages ?? []),
    "gen_ai.request.body": safeBody(params),
  }), "recording an OpenAI request");
  return span;
}

export function patchOpenAI(
  client: EvalKitClient,
  completions: Completions,
  parentCtx?: OtelContext,
  system: string = "openai"
): void {
  if (!completions || typeof completions.create !== "function") return;
  if ((completions.create as { __evalkit?: boolean }).__evalkit) return;
  if (!claimPatch(completions, "create")) return;

  const original = completions.create;

  const traced = function (this: unknown, ...args: unknown[]): unknown {
    const started = guarded("starting an OpenAI chat span", () => {
      const params = (args[0] ?? {}) as CreateParams;
      // Inside a framework's model run, the call takes that run's place.
      const framework = claimFrameworkModelRun();
      const ctx = parentCtx ?? framework?.ctx ?? otelContext.active();
      const span = startChatSpan(client, params, ctx, system);
      if (framework) span.setAttributes(framework.attributes);
      return {
        span,
        ctx: trace.setSpan(ctx, span),
        stream: !!params.stream,
        warnOnZeroUsage: system === "openai" && !params.stream_options?.include_usage,
        startMs: Date.now(),
      };
    }, undefined);
    if (!started) return original.apply(this, args);

    const { span } = started;
    return observeCall(
      () => otelContext.with(started.ctx, () => original.apply(this, args)),
      (result) => started.stream
        ? recordChatStream(client, result, span, started.startMs, started.warnOnZeroUsage)
        : recordChatResult(client, result as ChatCompletion, span),
      (err) => endSpan(span, err),
    );
  };

  (traced as { __evalkit?: boolean }).__evalkit = true;
  try {
    completions.create = traced;
  } catch (err) {
    swallow("patching chat.completions.create", err);
  }
}

function messagesToText(messages: Messages): string {
  return messages
    .map((m) => `${m.role}: ${messageContentText(m.content)}`)
    .join("\n");
}
