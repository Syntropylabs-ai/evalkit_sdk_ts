import { SpanKind, context as otelContext, trace } from "@opentelemetry/api";
import type { Span, Context as OtelContext } from "@opentelemetry/api";
import type { EvalKitClient } from "../../../core/client.js";
import { guarded, swallow } from "../../../core/guard.js";
import { messageContentText } from "../../../core/message-content.js";
import { claimPatch } from "../../_patched.js";
import { emitToolCalls } from "../_toolcalls.js";
import type { NormalizedToolCall } from "../_toolcalls.js";
import { safeBody } from "../_body.js";
import { toolAttrs } from "../_request.js";
import { observeCall } from "../_api-promise.js";
import { FirstToken, StreamText, StreamToolCalls, observeStream } from "../_stream.js";
import { endSpan, setAttributes } from "../_span.js";
import { claimFrameworkModelRun } from "../../../core/framework-model-call.js";

// cohere-ai: CohereClient (the v1 chat API, `message` and `chatHistory`) and CohereClientV2 (`messages`),
// each with `chat` and `chatStream`.

type ChatParams = {
  model?: string;
  message?: string;
  messages?: Array<{ role?: string; content?: unknown }>;
  chatHistory?: Array<{ role: string; message?: string }>;
  temperature?: number;
  maxTokens?: number;
  p?: number;
  preamble?: string;
  tools?: unknown[];
  stream?: boolean;
};
type Tokens = { inputTokens?: number; outputTokens?: number };
type ChatResponse = {
  text?: string;
  generationId?: string;
  id?: string;
  finishReason?: string;
  meta?: { tokens?: Tokens; billedUnits?: Tokens };
  usage?: { tokens?: Tokens; billedUnits?: Tokens };
  toolCalls?: Array<{ name?: string; parameters?: unknown }>;
  message?: { content?: Array<{ type?: string; text?: string }>; toolCalls?: Array<{ id?: string; function?: { name?: string; arguments?: unknown } }> };
};
type CohereChat = { chat?: (...args: unknown[]) => unknown; chatStream?: (...args: unknown[]) => unknown };

function promptText(params: ChatParams): string {
  if (Array.isArray(params.messages)) {
    return params.messages.map((m) => `${m.role ?? "user"}: ${messageContentText(m.content)}`).join("\n");
  }
  const historyLines = params.chatHistory?.map((h) => `${h.role}: ${h.message ?? ""}`) ?? [];
  return [
    params.preamble ? `system: ${params.preamble}` : "",
    ...historyLines,
    `user: ${params.message ?? ""}`,
  ].filter(Boolean).join("\n");
}

function tokensOf(result: ChatResponse | undefined): Tokens {
  const holder = result?.meta ?? result?.usage;
  return holder?.tokens ?? holder?.billedUnits ?? {};
}

function replyText(result: ChatResponse): string {
  if (typeof result.text === "string") return result.text;
  return (result.message?.content ?? [])
    .filter((block) => block?.type === "text" && typeof block.text === "string")
    .map((block) => block.text)
    .join("");
}

function toolCallsOf(result: ChatResponse): NormalizedToolCall[] {
  const tools = new StreamToolCalls();
  for (const call of result.toolCalls ?? []) tools.add(call?.name, call?.parameters ?? {});
  for (const call of result.message?.toolCalls ?? []) tools.add(call?.function?.name, call?.function?.arguments ?? {}, call?.id);
  return tools.calls();
}

function recordChat(client: EvalKitClient, result: ChatResponse, span: Span, model: string): ChatResponse {
  setAttributes(span, () => {
    const tokens = tokensOf(result);
    return {
      "gen_ai.response.model": model,
      "gen_ai.response.id": result.generationId ?? result.id ?? "",
      "gen_ai.usage.input_tokens": tokens.inputTokens ?? 0,
      "gen_ai.usage.output_tokens": tokens.outputTokens ?? 0,
      "gen_ai.response.finish_reasons": result.finishReason ? [result.finishReason] : [],
      "evalkit.completion": replyText(result),
      "gen_ai.response.body": safeBody(result),
    };
  }, "recording a Cohere reply");
  guarded("recording Cohere tool calls", () => emitToolCalls(client, span, toolCallsOf(result)), undefined);
  endSpan(span);
  return result;
}

function recordChatStream(client: EvalKitClient, stream: unknown, span: Span, model: string, startMs: number): unknown {
  const text = new StreamText();
  const thinking = new StreamText();
  const tools = new StreamToolCalls();
  // The whole calls Cohere's v1 API sends after their chunks; they stand for what the chunks assembled.
  let wholeCalls: StreamToolCalls | undefined;
  const first = new FirstToken(startMs);
  let tokens: Tokens = {};
  let responseId = "";
  let finishReason = "";

  const addText = (value: unknown): void => {
    if (text.append(value)) first.mark();
  };
  const addThinking = (value: unknown): void => {
    if (thinking.append(value)) first.mark();
  };

  const onV1Event = (event: any, type: string): void => {
    if (type === "stream-start") {
      if (typeof event.generationId === "string") responseId = event.generationId;
    } else if (type === "text-generation") {
      addText(event.text);
    } else if (type === "tool-calls-chunk") {
      const delta = event.toolCallDelta;
      if (delta) {
        const entry = tools.entry(`v1:${delta.index ?? 0}`);
        tools.describe(entry, delta.name);
        tools.appendArguments(entry, delta.parameters);
        addThinking(delta.text);
      }
    } else if (type === "tool-calls-generation") {
      const whole = new StreamToolCalls();
      for (const call of event.toolCalls ?? []) whole.add(call?.name, call?.parameters ?? {});
      if (whole.size > 0) wholeCalls = whole;
      if (thinking.empty) addThinking(event.text);
    } else if (type === "stream-end") {
      if (typeof event.finishReason === "string") finishReason = event.finishReason;
      const response = event.response as ChatResponse | undefined;
      if (response) {
        responseId = response.generationId ?? response.id ?? responseId;
        const t = tokensOf(response);
        if (t.inputTokens || t.outputTokens) tokens = t;
      }
    }
  };

  const onV2Event = (event: any, type: string): void => {
    const message = event.delta?.message;
    if (type === "message-start") {
      if (typeof event.id === "string") responseId = event.id;
    } else if (type === "content-delta") {
      addText(message?.content?.text);
      addThinking(message?.content?.thinking);
    } else if (type === "tool-plan-delta") {
      addThinking(message?.toolPlan);
    } else if (type === "tool-call-start" || type === "tool-call-delta") {
      const call = message?.toolCalls;
      if (call) {
        const entry = tools.entry(`v2:${event.index ?? 0}`);
        tools.describe(entry, call.function?.name, call.id);
        tools.appendArguments(entry, call.function?.arguments);
      }
    } else if (type === "message-end") {
      if (typeof event.delta?.finishReason === "string") finishReason = event.delta.finishReason;
      const usage = event.delta?.usage;
      const t = usage?.tokens ?? usage?.billedUnits;
      if (t && (t.inputTokens || t.outputTokens)) tokens = t;
    }
  };

  const onChunk = (event: any): void => {
    if (typeof event?.eventType === "string") onV1Event(event, event.eventType);
    else if (typeof event?.type === "string") onV2Event(event, event.type);
  };

  const onEnd = (error?: Error): void => {
    const completion = text.toString();
    const thought = thinking.toString();
    setAttributes(span, () => ({
      "gen_ai.response.model": model,
      ...(responseId && { "gen_ai.response.id": responseId }),
      "gen_ai.usage.input_tokens": tokens.inputTokens ?? 0,
      "gen_ai.usage.output_tokens": tokens.outputTokens ?? 0,
      ...(finishReason && { "gen_ai.response.finish_reasons": [finishReason] }),
      "gen_ai.streaming": true,
      "evalkit.completion": completion,
      ...(thought && { "gen_ai.response.thinking": thought }),
      ...first.attributes(error),
      "gen_ai.response.body": safeBody({ text: completion }),
    }), "recording a streamed Cohere reply");
    guarded("recording streamed Cohere tool calls", () => emitToolCalls(client, span, (wholeCalls ?? tools).calls()), undefined);
    endSpan(span, error);
  };

  return observeStream(stream, onChunk, onEnd);
}

function startChatSpan(client: EvalKitClient, params: ChatParams, ctx: OtelContext, operation: string, streaming: boolean): Span {
  const span = client.tracer.startSpan(
    operation,
    {
      kind: SpanKind.CLIENT,
      attributes: {
        "evalkit.span_type": "llm_call",
        "gen_ai.system": "cohere",
        "gen_ai.request.model": params.model ?? "unknown",
      },
    },
    ctx,
  );
  setAttributes(span, () => ({
    ...(params.temperature != null && { "gen_ai.request.temperature": params.temperature }),
    ...(params.maxTokens != null && { "gen_ai.request.max_tokens": params.maxTokens }),
    ...(params.p != null && { "gen_ai.request.top_p": params.p }),
    ...toolAttrs(params.tools),
    ...(streaming && { "gen_ai.streaming": true }),
    "evalkit.prompt": promptText(params),
    "gen_ai.request.body": safeBody(params),
  }), "recording a Cohere request");
  return span;
}

function patchMethod(client: EvalKitClient, target: CohereChat, method: "chat" | "chatStream", parentCtx?: OtelContext): void {
  const original = target[method];
  if (typeof original !== "function" || (original as { __evalkit?: boolean }).__evalkit) return;
  if (!claimPatch(target, method)) return;

  const traced = function (this: unknown, ...args: unknown[]): unknown {
    const started = guarded("starting a Cohere span", () => {
      const params = (args[0] ?? {}) as ChatParams;
      // chat() with `stream: true` answers with the same events as chatStream().
      const streaming = method === "chatStream" || !!params.stream;
      // Inside a framework's model run, the call takes that run's place.
      const framework = claimFrameworkModelRun();
      const ctx = parentCtx ?? framework?.ctx ?? otelContext.active();
      const span = startChatSpan(client, params, ctx, method === "chatStream" ? "chat_stream" : "chat", streaming);
      if (framework) span.setAttributes(framework.attributes);
      return { span, ctx: trace.setSpan(ctx, span), streaming, model: params.model ?? "unknown", startMs: Date.now() };
    }, undefined);
    if (!started) return original.apply(this, args);

    const { span } = started;
    return observeCall(
      () => otelContext.with(started.ctx, () => original.apply(this, args)),
      (result) => started.streaming
        ? recordChatStream(client, result, span, started.model, started.startMs)
        : recordChat(client, result as ChatResponse, span, started.model),
      (err) => endSpan(span, err),
    );
  };

  (traced as { __evalkit?: boolean }).__evalkit = true;
  try {
    target[method] = traced;
  } catch (err) {
    swallow(`patching Cohere ${method}`, err);
  }
}

export function patchCohere(
  client: EvalKitClient,
  cohereClient: CohereChat,
  parentCtx?: OtelContext
): void {
  if (!cohereClient) return;
  patchMethod(client, cohereClient, "chat", parentCtx);
  patchMethod(client, cohereClient, "chatStream", parentCtx);
}
