import { SpanKind, SpanStatusCode, context as otelContext, trace } from "@opentelemetry/api";
import type { Span } from "@opentelemetry/api";
import type { EvalKitClient } from "../../core/client.js";
import { safeBody } from "./_body.js";

type OllamaMessage = { role: string; content: string; thinking?: string; tool_calls?: unknown[] };
type ChatParams = { model?: string; messages?: OllamaMessage[]; stream?: boolean };
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

function wrapOllamaStream(stream: any, span: Span, startMs: number): any {
  let content = "";
  let thinking = "";
  let tokensIn = 0;
  let tokensOut = 0;
  let doneReason: string | undefined;
  let ttftMs: number | undefined;
  let finished = false;
  const chunks: ChatResponse[] = [];

  function finish(error?: Error) {
    if (finished) return;
    finished = true;
    span.setAttributes({
      "evalkit.completion": content,
      ...(thinking && { "gen_ai.response.thinking": thinking }),
      "gen_ai.usage.input_tokens": tokensIn,
      "gen_ai.usage.output_tokens": tokensOut,
      "gen_ai.streaming": true,
      ...(doneReason && { "gen_ai.response.finish_reasons": [doneReason] }),
      ...(!error && ttftMs !== undefined && { "gen_ai.server.time_to_first_token_ms": ttftMs }),
    });
    const body = safeBody(chunks);
    if (body) span.setAttribute("gen_ai.response.body", body);
    if (error) {
      span.recordException(error);
      span.setStatus({ code: SpanStatusCode.ERROR, message: error.message });
    } else {
      span.setStatus({ code: SpanStatusCode.OK });
    }
    span.end();
  }

  async function* tracedIterator() {
    try {
      for await (const chunk of stream as AsyncIterable<ChatResponse>) {
        chunks.push(chunk);
        const delta = chunk?.message?.content;
        if (delta) {
          if (ttftMs === undefined) ttftMs = Date.now() - startMs;
          content += delta;
        }
        if (chunk?.message?.thinking) thinking += chunk.message.thinking;
        if (chunk?.prompt_eval_count) tokensIn = chunk.prompt_eval_count;
        if (chunk?.eval_count) tokensOut = chunk.eval_count;
        if (chunk?.done_reason) doneReason = chunk.done_reason;
        yield chunk;
      }
    } catch (err) {
      finish(err instanceof Error ? err : new Error(String(err)));
      throw err;
    } finally {
      try { finish(); } catch {  }
    }
  }

  return new Proxy(stream, {
    get(target, prop, receiver) {
      if (prop === Symbol.asyncIterator) return () => tracedIterator();
      const value = Reflect.get(target, prop, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

function patchChatMethod(client: EvalKitClient, proto: any): void {
  if (typeof proto?.chat !== "function" || proto.chat.__evalkit) return;
  const original = proto.chat;

  proto.chat = async function (this: unknown, params: ChatParams, ...rest: unknown[]) {
    const ctx = otelContext.active();
    const span = client.tracer.startSpan(
      "chat",
      {
        kind: SpanKind.CLIENT,
        attributes: {
          "evalkit.span_type": "llm_call",
          "gen_ai.system": "ollama",
          "gen_ai.request.model": params?.model ?? "unknown",
          "evalkit.prompt": messagesToText(params?.messages),
        },
      },
      ctx,
    );
    const reqBody = safeBody(params);
    if (reqBody) span.setAttribute("gen_ai.request.body", reqBody);

    const spanCtx = trace.setSpan(ctx, span);
    const startMs = Date.now();
    let result: any;
    try {
      result = await otelContext.with(spanCtx, () => original.call(this, params, ...rest));
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      span.recordException(error);
      span.setStatus({ code: SpanStatusCode.ERROR, message: error.message });
      span.end();
      throw err;
    }

    if (params?.stream) {
      return wrapOllamaStream(result, span, startMs);
    }

    const resp = result as ChatResponse;
    span.setAttributes({
      "evalkit.completion": resp?.message?.content ?? "",
      ...(resp?.message?.thinking && { "gen_ai.response.thinking": resp.message.thinking }),
      "gen_ai.usage.input_tokens": resp?.prompt_eval_count ?? 0,
      "gen_ai.usage.output_tokens": resp?.eval_count ?? 0,
      ...(resp?.done_reason && { "gen_ai.response.finish_reasons": [resp.done_reason] }),
      ...(resp?.message?.tool_calls?.length && { "gen_ai.response.tool_call_count": resp.message.tool_calls.length }),
    });
    const respBody = safeBody(result);
    if (respBody) span.setAttribute("gen_ai.response.body", respBody);
    span.setStatus({ code: SpanStatusCode.OK });
    span.end();
    return result;
  };
  proto.chat.__evalkit = true;
}

export function patchOllama(client: EvalKitClient, OllamaClass: any): void {
  if (!OllamaClass?.prototype) return;
  patchChatMethod(client, OllamaClass.prototype);
}
