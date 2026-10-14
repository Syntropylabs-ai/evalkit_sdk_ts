import { SpanKind, context as otelContext, trace } from "@opentelemetry/api";
import type { Span } from "@opentelemetry/api";
import type { EvalKitClient } from "../../core/client.js";
import { guarded, swallow } from "../../core/guard.js";
import { claimPatch } from "../_patched.js";
import { safeBody } from "./_body.js";
import { samplingAttrs, toolAttrs } from "./_request.js";
import { emitToolCalls } from "./_toolcalls.js";
import { observeCall } from "./_api-promise.js";
import { FirstToken, StreamText, StreamToolCalls, observeStream } from "./_stream.js";
import { endSpan, setAttributes } from "./_span.js";
import { claimFrameworkModelRun } from "../../core/framework-model-call.js";

type OllamaToolCall = { function?: { name?: string; arguments?: unknown } };
type OllamaMessage = { role: string; content: string; thinking?: string; tool_calls?: OllamaToolCall[] };
type ChatParams = {
  model?: string;
  messages?: OllamaMessage[];
  stream?: boolean;
  tools?: unknown[];
  options?: { temperature?: number; top_p?: number; num_predict?: number };
};
type ChatResponse = {
  model: string;
  message: OllamaMessage;
  done_reason?: string;
  prompt_eval_count?: number;
  eval_count?: number;
};

function messagesToText(messages: OllamaMessage[] = []): string {
  return messages.map((m) => `${m.role}: ${m.content ?? ""}`).join("\n");
}

// Ollama sends each tool call whole, in the message that asks for it.
function addToolCalls(tools: StreamToolCalls, message: OllamaMessage | undefined): void {
  for (const call of message?.tool_calls ?? []) tools.add(call?.function?.name, call?.function?.arguments ?? {});
}

function recordOllamaStream(client: EvalKitClient, stream: unknown, span: Span, startMs: number): unknown {
  const text = new StreamText();
  const thinking = new StreamText();
  const tools = new StreamToolCalls();
  const first = new FirstToken(startMs);
  let tokensIn = 0;
  let tokensOut = 0;
  let doneReason: string | undefined;

  const onChunk = (chunk: ChatResponse): void => {
    if (text.append(chunk?.message?.content)) first.mark();
    if (thinking.append(chunk?.message?.thinking)) first.mark();
    addToolCalls(tools, chunk?.message);
    if (chunk?.prompt_eval_count) tokensIn = chunk.prompt_eval_count;
    if (chunk?.eval_count) tokensOut = chunk.eval_count;
    if (chunk?.done_reason) doneReason = chunk.done_reason;
  };

  const onEnd = (error?: Error): void => {
    const completion = text.toString();
    const thought = thinking.toString();
    setAttributes(span, () => ({
      "evalkit.completion": completion,
      ...(thought && { "gen_ai.response.thinking": thought }),
      "gen_ai.usage.input_tokens": tokensIn,
      "gen_ai.usage.output_tokens": tokensOut,
      "gen_ai.streaming": true,
      ...(doneReason && { "gen_ai.response.finish_reasons": [doneReason] }),
      ...(tools.size > 0 && { "gen_ai.response.tool_call_count": tools.size }),
      ...first.attributes(error),
      "gen_ai.response.body": safeBody({ text: completion }),
    }), "recording a streamed Ollama reply");
    guarded("recording streamed Ollama tool calls", () => emitToolCalls(client, span, tools.calls()), undefined);
    endSpan(span, error);
  };

  return observeStream(stream, onChunk, onEnd);
}

function recordOllamaResult(client: EvalKitClient, resp: ChatResponse, span: Span): ChatResponse {
  setAttributes(span, () => ({
    "evalkit.completion": resp?.message?.content ?? "",
    ...(resp?.message?.thinking && { "gen_ai.response.thinking": resp.message.thinking }),
    "gen_ai.usage.input_tokens": resp?.prompt_eval_count ?? 0,
    "gen_ai.usage.output_tokens": resp?.eval_count ?? 0,
    ...(resp?.done_reason && { "gen_ai.response.finish_reasons": [resp.done_reason] }),
    ...(resp?.message?.tool_calls?.length && { "gen_ai.response.tool_call_count": resp.message.tool_calls.length }),
    "gen_ai.response.body": safeBody(resp),
  }), "recording an Ollama reply");
  guarded("recording Ollama tool calls", () => {
    const tools = new StreamToolCalls();
    addToolCalls(tools, resp?.message);
    emitToolCalls(client, span, tools.calls());
  }, undefined);
  endSpan(span);
  return resp;
}

function patchChatMethod(client: EvalKitClient, proto: any): void {
  if (typeof proto?.chat !== "function" || proto.chat.__evalkit) return;
  if (!claimPatch(proto, "chat")) return;
  const original = proto.chat;

  const traced = function (this: unknown, ...args: unknown[]): unknown {
    const started = guarded("starting an Ollama span", () => {
      const params = (args[0] ?? {}) as ChatParams;
      const framework = claimFrameworkModelRun();
      const ctx = framework?.ctx ?? otelContext.active();
      const span = client.tracer.startSpan(
        "chat",
        {
          kind: SpanKind.CLIENT,
          attributes: {
            "evalkit.span_type": "llm_call",
            "gen_ai.system": "ollama",
            "gen_ai.request.model": params?.model ?? "unknown",
          },
        },
        ctx,
      );
      if (framework) span.setAttributes(framework.attributes);
      setAttributes(span, () => ({
        ...samplingAttrs({
          temperature: params?.options?.temperature,
          topP: params?.options?.top_p,
          maxTokens: params?.options?.num_predict,
        }),
        ...toolAttrs(params?.tools),
        "evalkit.prompt": messagesToText(params?.messages),
        "gen_ai.request.body": safeBody(params),
      }), "recording an Ollama request");
      return { span, ctx: trace.setSpan(ctx, span), stream: !!params?.stream, startMs: Date.now() };
    }, undefined);
    if (!started) return original.apply(this, args);

    const { span } = started;
    return observeCall(
      () => otelContext.with(started.ctx, () => original.apply(this, args)),
      (result) => started.stream
        ? recordOllamaStream(client, result, span, started.startMs)
        : recordOllamaResult(client, result as ChatResponse, span),
      (err) => endSpan(span, err),
    );
  };
  traced.__evalkit = true;
  try {
    proto.chat = traced;
  } catch (err) {
    swallow("patching Ollama chat", err);
  }
}

export function patchOllama(client: EvalKitClient, OllamaClass: any): void {
  if (!OllamaClass?.prototype) return;
  patchChatMethod(client, OllamaClass.prototype);
}
