import { SpanKind, context as otelContext, trace } from "@opentelemetry/api";
import type { Span, Context as OtelContext } from "@opentelemetry/api";
import type { EvalKitClient } from "../../../core/client.js";
import { guarded, swallow } from "../../../core/guard.js";
import { claimPatch } from "../../_patched.js";
import { emitToolCalls, fromAnthropicBlocks } from "../_toolcalls.js";
import { safeBody } from "../_body.js";
import { toolAttrs } from "../_request.js";
import { observeCall } from "../_api-promise.js";
import { FirstToken, StreamText, StreamToolCalls, observeStream } from "../_stream.js";
import { endSpan, setAttributes } from "../_span.js";
import { messageContentText } from "../../../core/message-content.js";
import { claimFrameworkModelRun } from "../../../core/framework-model-call.js";

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
type Messages = { create: (...args: unknown[]) => unknown };

function extractThinking(content: ContentBlock[]): { thinkingText: string; hasRedactedThinking: boolean } {
  const thinkingText = content
    .filter((b) => b.type === "thinking")
    .map((b) => b.thinking ?? "")
    .join("");
  const hasRedactedThinking = content.some((b) => b.type === "redacted_thinking");
  return { thinkingText, hasRedactedThinking };
}

function recordAnthropicStream(client: EvalKitClient, stream: unknown, span: Span, startMs: number): unknown {
  const text = new StreamText();
  const thinking = new StreamText();
  const tools = new StreamToolCalls();
  const first = new FirstToken(startMs);
  let hasRedactedThinking = false;
  let tokensIn = 0;
  let tokensOut = 0;
  let cacheReadTokens = 0;
  let cacheCreationTokens = 0;
  let responseId = '';
  let responseModel = '';
  let stopReason = '';

  const onChunk = (event: any): void => {
    const type = event?.type;
    if (type === 'content_block_delta') {
      const delta = event.delta;
      if (delta?.type === 'text_delta') {
        if (text.append(delta.text)) first.mark();
      } else if (delta?.type === 'thinking_delta') {
        if (thinking.append(delta.thinking)) first.mark();
      } else if (delta?.type === 'input_json_delta') {
        tools.appendArguments(tools.entry(String(event.index ?? 0)), delta.partial_json);
      }
    } else if (type === 'content_block_start') {
      const block = event.content_block;
      if (block?.type === 'redacted_thinking') hasRedactedThinking = true;
      if (block?.type === 'tool_use') {
        const entry = tools.entry(String(event.index ?? 0));
        tools.describe(entry, block.name, block.id);
        // The input arrives as JSON deltas; the start event's own input stands when none follow.
        if (block.input && typeof block.input === 'object' && Object.keys(block.input).length > 0) {
          tools.setArguments(entry, block.input);
        }
      }
    } else if (type === 'message_start') {
      const message = event.message;
      cacheReadTokens = message?.usage?.cache_read_input_tokens ?? 0;
      cacheCreationTokens = message?.usage?.cache_creation_input_tokens ?? 0;
      tokensIn = (message?.usage?.input_tokens ?? 0) + cacheReadTokens + cacheCreationTokens;
      if (typeof message?.id === 'string') responseId = message.id;
      if (typeof message?.model === 'string') responseModel = message.model;
    } else if (type === 'message_delta') {
      tokensOut = event.usage?.output_tokens ?? 0;
      if (typeof event.delta?.stop_reason === 'string') stopReason = event.delta.stop_reason;
    }
  };

  const onEnd = (error?: Error): void => {
    const completion = text.toString();
    const thought = thinking.toString();
    setAttributes(span, () => ({
      'evalkit.completion': completion,
      'gen_ai.usage.input_tokens': tokensIn,
      'gen_ai.usage.output_tokens': tokensOut,
      ...(cacheReadTokens > 0 && { 'gen_ai.usage.cache_read_tokens': cacheReadTokens }),
      ...(cacheCreationTokens > 0 && { 'gen_ai.usage.cache_creation_tokens': cacheCreationTokens }),
      'gen_ai.streaming': true,
      ...(responseModel && { 'gen_ai.response.model': responseModel }),
      ...(responseId && { 'gen_ai.response.id': responseId }),
      ...(stopReason && { 'gen_ai.response.finish_reasons': [stopReason] }),
      ...(thought && { 'gen_ai.response.thinking': thought }),
      ...(hasRedactedThinking && { 'gen_ai.response.has_redacted_thinking': true }),
      ...first.attributes(error),
      'gen_ai.response.body': safeBody({ text: completion }),
    }), 'recording a streamed Anthropic reply');
    guarded('recording streamed tool calls', () => emitToolCalls(client, span, tools.calls()), undefined);
    endSpan(span, error);
  };

  return observeStream(stream, onChunk, onEnd);
}

function recordMessage(client: EvalKitClient, result: Message, span: Span): Message {
  setAttributes(span, () => {
    const content = result.content ?? [];
    const textContent = content
      .filter((b) => b.type === "text")
      .map((b) => b.text ?? "")
      .join("");
    const { thinkingText, hasRedactedThinking } = extractThinking(content);
    const cacheReadTokens = result.usage?.cache_read_input_tokens ?? 0;
    const cacheCreationTokens = result.usage?.cache_creation_input_tokens ?? 0;
    const totalInputTokens = (result.usage?.input_tokens ?? 0) + cacheReadTokens + cacheCreationTokens;
    return {
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
      "gen_ai.response.body": safeBody(result),
    };
  }, "recording an Anthropic reply");
  guarded("recording tool calls", () => emitToolCalls(client, span, fromAnthropicBlocks(result.content)), undefined);
  endSpan(span);
  return result;
}

function startMessagesSpan(client: EvalKitClient, params: CreateParams, ctx: OtelContext, system: string): Span {
  const span = client.tracer.startSpan(
    "messages.create",
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
    "evalkit.prompt": buildPrompt(params.system, params.messages ?? []),
    "gen_ai.request.body": safeBody(params),
  }), "recording an Anthropic request");
  return span;
}

export function patchAnthropic(
  client: EvalKitClient,
  messages: Messages,
  parentCtx?: OtelContext,
  system: string = "anthropic",
): void {
  if (!messages || typeof messages.create !== "function") return;
  if ((messages.create as { __evalkit?: boolean }).__evalkit) return;
  if (!claimPatch(messages, "create")) return;

  const original = messages.create;

  const traced = function (this: unknown, ...args: unknown[]): unknown {
    const started = guarded("starting an Anthropic span", () => {
      const params = (args[0] ?? {}) as CreateParams;
      // Inside a framework's model run, the call takes that run's place.
      const framework = claimFrameworkModelRun();
      const ctx = parentCtx ?? framework?.ctx ?? otelContext.active();
      const span = startMessagesSpan(client, params, ctx, system);
      if (framework) span.setAttributes(framework.attributes);
      return { span, ctx: trace.setSpan(ctx, span), stream: !!params.stream, startMs: Date.now() };
    }, undefined);
    if (!started) return original.apply(this, args);

    const { span } = started;
    return observeCall(
      () => otelContext.with(started.ctx, () => original.apply(this, args)),
      (result) => started.stream
        ? recordAnthropicStream(client, result, span, started.startMs)
        : recordMessage(client, result as Message, span),
      (err) => endSpan(span, err),
    );
  };

  (traced as { __evalkit?: boolean }).__evalkit = true;
  try {
    messages.create = traced;
  } catch (err) {
    swallow("patching messages.create", err);
  }
}

function buildPrompt(system: unknown, messages: AnthropicMessages): string {
  const parts: string[] = [];
  if (system) parts.push(`system: ${messageContentText(system)}`);
  parts.push(...messages.map((m) => `${m.role}: ${messageContentText(m.content)}`));
  return parts.join("\n");
}
