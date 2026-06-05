import { SpanKind, SpanStatusCode, context as otelContext, trace } from "@opentelemetry/api";
import type { Span, Context as OtelContext } from "@opentelemetry/api";
import type { EvalKitClient } from "../../../core/client.js";
import { recordSimToolCall } from "../../../core/simulation.js";

// New unified Google SDK: `@google/genai`.
//   const ai = new GoogleGenAI({ apiKey });
//   ai.models.generateContent({ model, contents, config });
//   for await (const chunk of await ai.models.generateContentStream({...})) {}
// Patched at the Models prototype level so every client instance — including
// those created internally by frameworks/ADK — is traced.

type Part = { text?: string; functionCall?: { name?: string; args?: Record<string, unknown>; id?: string } };
type Content = { role?: string; parts?: Part[] };
type GenAIRequest = {
  model?: string;
  contents?: unknown;
  config?: { systemInstruction?: unknown };
};
type Candidate = { content?: { parts?: Part[] }; finishReason?: string };
type GenAIResponse = {
  text?: string;
  candidates?: Candidate[];
  functionCalls?: Array<{ name?: string; args?: Record<string, unknown>; id?: string }>;
  usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number; totalTokenCount?: number };
};
type ModelsProto = {
  generateContent?: (...args: unknown[]) => Promise<unknown>;
  generateContentStream?: (...args: unknown[]) => Promise<unknown>;
};

function extractText(part?: { text?: string }): string {
  return part?.text ?? "";
}

function contentsToText(contents: unknown): string {
  if (typeof contents === "string") return contents;
  if (Array.isArray(contents)) {
    return contents
      .map((item) => {
        if (typeof item === "string") return item;
        const c = item as Content;
        const role = c.role ?? "user";
        const text = (c.parts ?? []).map(extractText).join("");
        return text ? `${role}: ${text}` : "";
      })
      .filter(Boolean)
      .join("\n");
  }
  if (contents && typeof contents === "object") {
    const c = contents as Content;
    if (c.parts) return (c.parts ?? []).map(extractText).join("");
  }
  return contents != null ? String(contents) : "";
}

function systemText(config: GenAIRequest["config"]): string {
  const si = config?.systemInstruction as any;
  if (!si) return "";
  if (typeof si === "string") return si;
  if (Array.isArray(si?.parts)) return si.parts.map((p: any) => p?.text ?? "").join("");
  if (typeof si?.text === "string") return si.text;
  return "";
}

function buildPrompt(req: GenAIRequest): string {
  const sys = systemText(req?.config);
  const body = contentsToText(req?.contents);
  return [sys ? `system: ${sys}` : "", body].filter(Boolean).join("\n");
}

function completionFrom(resp: GenAIResponse): string {
  // Join all text parts across candidates.
  const parts: string[] = [];
  for (const cand of resp?.candidates ?? []) {
    for (const p of cand.content?.parts ?? []) {
      if (p.text) parts.push(p.text);
    }
  }
  if (parts.length) return parts.join("");
  return resp?.text ?? "";
}

function recordToolCalls(resp: GenAIResponse, span: Span, traceId: string | undefined): void {
  const calls: Array<{ name?: string; args?: Record<string, unknown>; id?: string }> = [];
  if (Array.isArray(resp?.functionCalls)) calls.push(...resp.functionCalls);
  else {
    for (const cand of resp?.candidates ?? []) {
      for (const p of cand.content?.parts ?? []) {
        if (p.functionCall?.name) calls.push(p.functionCall);
      }
    }
  }
  for (const fc of calls) {
    const name = fc.name ?? "";
    if (!name) continue;
    let argsJson = "";
    try { argsJson = JSON.stringify(fc.args ?? {}); } catch { argsJson = String(fc.args); }
    span.addEvent("gen_ai.tool.call", {
      "gen_ai.tool.name": name,
      "gen_ai.tool.call.arguments": argsJson,
      "gen_ai.tool.call.id": fc.id ?? "",
    });
    const toolSpan = client_tracer_startToolSpan(span);
    recordSimToolCall(traceId, name, fc.args);
    if (toolSpan) toolSpan.end();
  }
}

// Tool span helper bound lazily to avoid passing the client through every call.
let _client: EvalKitClient | null = null;
function client_tracer_startToolSpan(parent: Span): Span | null {
  if (!_client) return null;
  const ctx = trace.setSpan(otelContext.active(), parent);
  return _client.tracer.startSpan(
    "tool_call",
    { kind: SpanKind.INTERNAL, attributes: { "evalkit.span_type": "tool_call" } },
    ctx,
  );
}

export function patchGoogleGenAI(client: EvalKitClient, ModelsProto: ModelsProto, parentCtx?: OtelContext): void {
  _client = client;

  if (ModelsProto.generateContent && !(ModelsProto.generateContent as any).__evalkit) {
    const original = ModelsProto.generateContent;
    ModelsProto.generateContent = async function (this: unknown, ...args: unknown[]): Promise<unknown> {
      const req = (args[0] ?? {}) as GenAIRequest;
      const modelName = req.model ?? "unknown";
      const ctx = parentCtx ?? otelContext.active();
      const span = client.tracer.startSpan(
        "generateContent",
        {
          kind: SpanKind.CLIENT,
          attributes: {
            "evalkit.span_type": "llm_call",
            "gen_ai.system": "google-genai",
            "gen_ai.request.model": modelName,
            "evalkit.prompt": buildPrompt(req),
          },
        },
        ctx,
      );
      const spanCtx = trace.setSpan(ctx, span);
      let result: GenAIResponse;
      try {
        result = (await otelContext.with(spanCtx, () => original.apply(this, args))) as GenAIResponse;
      } catch (err) {
        const error = err instanceof Error ? err : new Error(String(err));
        span.recordException(error);
        span.setStatus({ code: SpanStatusCode.ERROR, message: error.message });
        span.end();
        throw err;
      }
      span.setAttributes({
        "gen_ai.response.model": modelName,
        "gen_ai.usage.input_tokens": result?.usageMetadata?.promptTokenCount ?? 0,
        "gen_ai.usage.output_tokens": result?.usageMetadata?.candidatesTokenCount ?? 0,
        "gen_ai.usage.total_tokens": result?.usageMetadata?.totalTokenCount ?? 0,
        "evalkit.completion": completionFrom(result),
      });
      try { recordToolCalls(result, span, span.spanContext().traceId); } catch { /* never break */ }
      span.setStatus({ code: SpanStatusCode.OK });
      span.end();
      return result;
    };
    (ModelsProto.generateContent as any).__evalkit = true;
  }

  if (ModelsProto.generateContentStream && !(ModelsProto.generateContentStream as any).__evalkit) {
    const original = ModelsProto.generateContentStream;
    ModelsProto.generateContentStream = async function (this: unknown, ...args: unknown[]): Promise<unknown> {
      const req = (args[0] ?? {}) as GenAIRequest;
      const modelName = req.model ?? "unknown";
      const ctx = parentCtx ?? otelContext.active();
      const span = client.tracer.startSpan(
        "generateContentStream",
        {
          kind: SpanKind.CLIENT,
          attributes: {
            "evalkit.span_type": "llm_call",
            "gen_ai.system": "google-genai",
            "gen_ai.request.model": modelName,
            "gen_ai.streaming": true,
            "evalkit.prompt": buildPrompt(req),
          },
        },
        ctx,
      );
      const spanCtx = trace.setSpan(ctx, span);
      let stream: AsyncIterable<GenAIResponse>;
      try {
        stream = (await otelContext.with(spanCtx, () => original.apply(this, args))) as AsyncIterable<GenAIResponse>;
      } catch (err) {
        const error = err instanceof Error ? err : new Error(String(err));
        span.recordException(error);
        span.setStatus({ code: SpanStatusCode.ERROR, message: error.message });
        span.end();
        throw err;
      }

      async function* traced(): AsyncGenerator<GenAIResponse> {
        const parts: string[] = [];
        let tin = 0;
        let tout = 0;
        try {
          for await (const chunk of stream) {
            try {
              const t = completionFrom(chunk);
              if (t) parts.push(t);
              if (chunk?.usageMetadata) {
                tin = chunk.usageMetadata.promptTokenCount ?? tin;
                tout = chunk.usageMetadata.candidatesTokenCount ?? tout;
              }
              recordToolCalls(chunk, span, span.spanContext().traceId);
            } catch { /* never break the stream */ }
            yield chunk;
          }
          span.setAttributes({
            "gen_ai.response.model": modelName,
            "gen_ai.usage.input_tokens": tin,
            "gen_ai.usage.output_tokens": tout,
            "evalkit.completion": parts.join(""),
          });
          span.setStatus({ code: SpanStatusCode.OK });
        } catch (err) {
          const error = err instanceof Error ? err : new Error(String(err));
          span.recordException(error);
          span.setStatus({ code: SpanStatusCode.ERROR, message: error.message });
          throw err;
        } finally {
          span.end();
        }
      }

      return traced();
    };
    (ModelsProto.generateContentStream as any).__evalkit = true;
  }
}
