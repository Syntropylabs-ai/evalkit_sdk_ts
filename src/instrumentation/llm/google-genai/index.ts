import { SpanKind, SpanStatusCode, context as otelContext, trace } from "@opentelemetry/api";
import type { Span, Context as OtelContext } from "@opentelemetry/api";
import type { EvalKitClient } from "../../../core/client.js";
import { emitToolCalls, fromGoogleParts } from "../_toolcalls.js";
import { safeBody } from "../_body.js";
import { samplingAttrs, toolAttrs } from "../_request.js";
import type { GoogleUsage, GoogleUsageMetadata } from "../_google-usage.js";
import { EMPTY_GOOGLE_USAGE, extractGoogleUsage, googleUsageAttributes, mergeGoogleUsage } from "../_google-usage.js";

type Part = { text?: string; thought?: boolean; functionCall?: { name?: string; args?: Record<string, unknown>; id?: string } };
type Content = { role?: string; parts?: Part[] };
type GenAIRequest = {
  model?: string;
  contents?: unknown;
  config?: {
    systemInstruction?: unknown;
    tools?: unknown[];
    temperature?: number;
    topP?: number;
    maxOutputTokens?: number;
  };
};
type Candidate = { content?: { parts?: Part[] }; finishReason?: string };
type GenAIResponse = {
  text?: string;
  candidates?: Candidate[];
  functionCalls?: Array<{ name?: string; args?: Record<string, unknown>; id?: string }>;
  usageMetadata?: GoogleUsageMetadata;
};
type ModelsProto = {
  generateContent?: (...args: unknown[]) => Promise<unknown>;
  generateContentStream?: (...args: unknown[]) => Promise<unknown>;
};

function requestAttrs(req: GenAIRequest): Record<string, number | string[]> {
  const config = req.config;
  return {
    ...samplingAttrs({ temperature: config?.temperature, topP: config?.topP, maxTokens: config?.maxOutputTokens }),
    ...toolAttrs(config?.tools),
  };
}

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

function splitCandidateText(resp: GenAIResponse): { completion: string; thinking: string } {
  const parts: string[] = [];
  const thoughts: string[] = [];
  let sawThought = false;
  for (const cand of resp?.candidates ?? []) {
    for (const p of cand.content?.parts ?? []) {
      if (p.thought) {
        sawThought = true;
        if (p.text) thoughts.push(p.text);
        continue;
      }
      if (p.text) parts.push(p.text);
    }
  }
  const thinking = thoughts.join("");
  if (parts.length) return { completion: parts.join(""), thinking };
  if (sawThought) return { completion: "", thinking };
  return { completion: resp?.text ?? "", thinking };
}

let _client: EvalKitClient | null = null;

function recordToolCalls(resp: GenAIResponse, span: Span, _traceId?: string | undefined): void {
  if (!_client) return;
  emitToolCalls(_client, span, fromGoogleParts(resp));
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
            ...requestAttrs(req),
            "evalkit.prompt": buildPrompt(req),
          },
        },
        ctx,
      );
      const reqBody = safeBody(req);
      if (reqBody) span.setAttribute("gen_ai.request.body", reqBody);
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
      const { completion, thinking } = splitCandidateText(result);
      span.setAttributes({
        "gen_ai.response.model": modelName,
        ...googleUsageAttributes(extractGoogleUsage(result?.usageMetadata)),
        "evalkit.completion": completion,
        ...(thinking && { "gen_ai.response.thinking": thinking }),
      });

      const respBody = safeBody(result);
      if (respBody) span.setAttribute("gen_ai.response.body", respBody);
      try { recordToolCalls(result, span, span.spanContext().traceId); } catch {  }
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
      const startMs = Date.now();
      const ctx = parentCtx ?? otelContext.active();
      const span = client.tracer.startSpan(
        "generateContentStream",
        {
          kind: SpanKind.CLIENT,
          attributes: {
            "evalkit.span_type": "llm_call",
            "gen_ai.system": "google-genai",
            "gen_ai.request.model": modelName,
            ...requestAttrs(req),
            "gen_ai.streaming": true,
            "evalkit.prompt": buildPrompt(req),
          },
        },
        ctx,
      );
      const reqBody = safeBody(req);
      if (reqBody) span.setAttribute("gen_ai.request.body", reqBody);
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
        const thoughtParts: string[] = [];
        let usage: GoogleUsage = EMPTY_GOOGLE_USAGE;
        let ttftMs: number | undefined;
        let failure: Error | undefined;
        try {
          for await (const chunk of stream) {
            try {
              const { completion: t, thinking: th } = splitCandidateText(chunk);
              if (t) {
                if (ttftMs === undefined) ttftMs = Date.now() - startMs;
                parts.push(t);
              }
              if (th) {
                if (ttftMs === undefined) ttftMs = Date.now() - startMs;
                thoughtParts.push(th);
              }
              if (chunk?.usageMetadata) {
                usage = mergeGoogleUsage(usage, extractGoogleUsage(chunk.usageMetadata));
              }
              recordToolCalls(chunk, span, span.spanContext().traceId);
            } catch {  }
            yield chunk;
          }
        } catch (err) {
          failure = err instanceof Error ? err : new Error(String(err));
          throw err;
        } finally {
          try {
            const thinking = thoughtParts.join("");
            span.setAttributes({
              "gen_ai.response.model": modelName,
              ...googleUsageAttributes(usage),
              "evalkit.completion": parts.join(""),
              ...(thinking && { "gen_ai.response.thinking": thinking }),
              ...(!failure && ttftMs !== undefined && { "gen_ai.server.time_to_first_token_ms": ttftMs }),
            });
            const respBody = safeBody({ text: parts.join("") });
            if (respBody) span.setAttribute("gen_ai.response.body", respBody);
          } catch {  }
          if (failure) {
            span.recordException(failure);
            span.setStatus({ code: SpanStatusCode.ERROR, message: failure.message });
          } else {
            span.setStatus({ code: SpanStatusCode.OK });
          }
          span.end();
        }
      }

      return traced();
    };
    (ModelsProto.generateContentStream as any).__evalkit = true;
  }
}
