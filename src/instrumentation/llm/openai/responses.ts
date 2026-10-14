import { SpanKind, context as otelContext, trace } from "@opentelemetry/api";
import type { Span, Context as OtelContext } from "@opentelemetry/api";
import type { EvalKitClient } from "../../../core/client.js";
import { guarded, swallow } from "../../../core/guard.js";
import { messageContentText } from "../../../core/message-content.js";
import { claimPatch } from "../../_patched.js";
import { emitToolCalls, fromOpenAIResponses } from "../_toolcalls.js";
import { safeBody } from "../_body.js";
import { samplingAttrs, toolAttrs } from "../_request.js";
import { observeCall } from "../_api-promise.js";
import { FirstToken, StreamText, observeStream } from "../_stream.js";
import { endSpan, setAttributes } from "../_span.js";
import { claimFrameworkModelRun } from "../../../core/framework-model-call.js";

// The OpenAI Responses API (client.responses.create, and the parse() and stream() helpers built on it),
// recorded as one llm_call named responses.create, as the Python SDK records it.

type ResponsesParams = {
  model?: string;
  input?: unknown;
  instructions?: unknown;
  stream?: boolean;
  temperature?: number;
  top_p?: number;
  max_output_tokens?: number;
  tools?: unknown[];
};

type Usage = {
  input_tokens?: number;
  output_tokens?: number;
  total_tokens?: number;
  input_tokens_details?: { cached_tokens?: number };
  output_tokens_details?: { reasoning_tokens?: number };
};

type ResponseObject = {
  id?: string;
  model?: string;
  output?: any[];
  output_text?: string;
  usage?: Usage;
  error?: { message?: string; code?: string } | null;
};

type ResponsesResource = { create: (...args: unknown[]) => unknown };

function inputText(input: unknown): string {
  if (typeof input === "string") return input;
  if (!Array.isArray(input)) return input == null ? "" : messageContentText(input);
  return input
    .map((item) => {
      if (typeof item === "string") return item;
      const role = typeof item?.role === "string" ? item.role : "";
      const text = messageContentText(item?.content ?? item?.output ?? "");
      return role ? `${role}: ${text}` : text;
    })
    .filter((line) => line !== "")
    .join("\n");
}

function promptText(params: ResponsesParams): string {
  const system = params.instructions ? `system: ${messageContentText(params.instructions)}` : "";
  return [system, inputText(params.input)].filter(Boolean).join("\n");
}

function outputText(response: ResponseObject): string {
  if (typeof response.output_text === "string") return response.output_text;
  const parts: string[] = [];
  for (const item of response.output ?? []) {
    if (item?.type !== "message") continue;
    for (const block of item.content ?? []) {
      if (block?.type === "output_text" && typeof block.text === "string") parts.push(block.text);
    }
  }
  return parts.join("");
}

function reasoningText(output: any[] | undefined): string {
  const parts: string[] = [];
  for (const item of output ?? []) {
    if (item?.type !== "reasoning") continue;
    for (const block of item.summary ?? []) {
      if (typeof block?.text === "string") parts.push(block.text);
    }
  }
  return parts.join("\n");
}

function usageAttributes(usage: Usage | undefined): Record<string, number> {
  const input = usage?.input_tokens ?? 0;
  const output = usage?.output_tokens ?? 0;
  const cached = usage?.input_tokens_details?.cached_tokens ?? 0;
  const reasoning = usage?.output_tokens_details?.reasoning_tokens ?? 0;
  return {
    "gen_ai.usage.input_tokens": input,
    "gen_ai.usage.output_tokens": output,
    "gen_ai.usage.total_tokens": usage?.total_tokens ?? input + output,
    ...(cached > 0 && { "gen_ai.usage.cache_read_tokens": cached }),
    ...(reasoning > 0 && { "gen_ai.usage.reasoning_tokens": reasoning }),
  };
}

function recordResponse(client: EvalKitClient, response: ResponseObject, span: Span): ResponseObject {
  setAttributes(span, () => {
    const thinking = reasoningText(response.output);
    return {
      ...(response.model && { "gen_ai.response.model": response.model }),
      ...(response.id && { "gen_ai.response.id": response.id }),
      ...usageAttributes(response.usage),
      "evalkit.completion": outputText(response),
      ...(thinking && { "gen_ai.response.thinking": thinking }),
      "gen_ai.response.body": safeBody(response),
    };
  }, "recording an OpenAI response");
  guarded("recording response tool calls", () => emitToolCalls(client, span, fromOpenAIResponses(response.output)), undefined);
  endSpan(span);
  return response;
}

function recordResponseStream(client: EvalKitClient, stream: unknown, span: Span, startMs: number): unknown {
  const text = new StreamText();
  const thinking = new StreamText();
  const first = new FirstToken(startMs);
  // Output items by id as they arrive, so a stream that dies before its final event keeps the calls it made.
  const items = new Map<string, any>();
  let final: ResponseObject | undefined;
  let responseId = "";
  let responseModel = "";
  let streamError: Error | undefined;

  const onChunk = (event: any): void => {
    const type = event?.type;
    if (type === "response.output_text.delta") {
      if (text.append(event.delta)) first.mark();
    } else if (type === "response.reasoning_summary_text.delta" || type === "response.reasoning_text.delta") {
      if (thinking.append(event.delta)) first.mark();
    } else if (type === "response.refusal.delta") {
      if (typeof event.delta === "string" && event.delta) first.mark();
    } else if (type === "response.output_item.added" || type === "response.output_item.done") {
      const item = event.item;
      if (item && typeof item === "object") items.set(String(item.id ?? items.size), { ...item });
    } else if (type === "response.function_call_arguments.delta") {
      const item = items.get(String(event.item_id));
      if (item && typeof event.delta === "string") item.arguments = `${item.arguments ?? ""}${event.delta}`;
    } else if (type === "response.created" || type === "response.in_progress") {
      responseId = event.response?.id ?? responseId;
      responseModel = event.response?.model ?? responseModel;
    } else if (type === "response.completed" || type === "response.incomplete" || type === "response.failed") {
      final = event.response ?? final;
      if (type === "response.failed") {
        streamError = new Error(final?.error?.message || final?.error?.code || "response.failed");
      }
    } else if (type === "error") {
      streamError = new Error(event.message || event.code || "the response stream reported an error");
    }
  };

  const onEnd = (error?: Error): void => {
    const failure = error ?? streamError;
    const completion = text.empty && final ? outputText(final) : text.toString();
    const output = final?.output ?? [...items.values()];
    const reasoning = thinking.toString();
    setAttributes(span, () => ({
      "gen_ai.streaming": true,
      ...((final?.model || responseModel) && { "gen_ai.response.model": final?.model || responseModel }),
      ...((final?.id || responseId) && { "gen_ai.response.id": final?.id || responseId }),
      ...usageAttributes(final?.usage),
      "evalkit.completion": completion,
      ...(reasoning && { "gen_ai.response.thinking": reasoning }),
      ...first.attributes(failure),
      "gen_ai.response.body": safeBody({ text: completion }),
    }), "recording a streamed OpenAI response");
    guarded("recording streamed response tool calls", () => emitToolCalls(client, span, fromOpenAIResponses(output)), undefined);
    endSpan(span, failure);
  };

  return observeStream(stream, onChunk, onEnd);
}

function startResponsesSpan(client: EvalKitClient, params: ResponsesParams, ctx: OtelContext): Span {
  const span = client.tracer.startSpan(
    "responses.create",
    {
      kind: SpanKind.CLIENT,
      attributes: {
        "evalkit.span_type": "llm_call",
        "gen_ai.system": "openai",
        "gen_ai.request.model": params.model ?? "unknown",
      },
    },
    ctx,
  );
  setAttributes(span, () => ({
    ...samplingAttrs({ temperature: params.temperature, topP: params.top_p, maxTokens: params.max_output_tokens }),
    ...toolAttrs(params.tools),
    ...(params.stream && { "gen_ai.streaming": true }),
    "evalkit.prompt": promptText(params),
    "gen_ai.request.body": safeBody(params),
  }), "recording an OpenAI Responses request");
  return span;
}

export function patchOpenAIResponses(client: EvalKitClient, responses: ResponsesResource): void {
  if (!responses || typeof responses.create !== "function") return;
  if ((responses.create as { __evalkit?: boolean }).__evalkit) return;
  if (!claimPatch(responses, "create")) return;

  const original = responses.create;
  const traced = function (this: unknown, ...args: unknown[]): unknown {
    const started = guarded("starting an OpenAI Responses span", () => {
      const params = (args[0] ?? {}) as ResponsesParams;
      // Inside a framework's model run, the call takes that run's place.
      const framework = claimFrameworkModelRun();
      const ctx = framework?.ctx ?? otelContext.active();
      const span = startResponsesSpan(client, params, ctx);
      if (framework) span.setAttributes(framework.attributes);
      return { span, ctx: trace.setSpan(ctx, span), stream: !!params.stream, startMs: Date.now() };
    }, undefined);
    if (!started) return original.apply(this, args);

    const { span } = started;
    return observeCall(
      () => otelContext.with(started.ctx, () => original.apply(this, args)),
      (result) => started.stream
        ? recordResponseStream(client, result, span, started.startMs)
        : recordResponse(client, result as ResponseObject, span),
      (err) => endSpan(span, err),
    );
  };

  (traced as { __evalkit?: boolean }).__evalkit = true;
  try {
    responses.create = traced;
  } catch (err) {
    swallow("patching responses.create", err);
  }
}
