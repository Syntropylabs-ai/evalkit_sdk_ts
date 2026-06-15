/**
 * Single source of truth for tool-call extraction across every LLM provider.
 *
 * Previously each provider (openai/anthropic/google-genai/langchain) re-implemented
 * the same three steps — addEvent on the LLM span, a child tool_call span, and a
 * recordSimToolCall — and they drifted (google-genai's child span had no attributes,
 * langchain created no child span at all). This module normalizes the provider
 * response into NormalizedToolCall[] and emits all three steps consistently.
 *
 * The child tool_call span carries BOTH the gen_ai.tool.* keys and the tool.* keys
 * so it renders identically to the Python SDK's promoted tool_call spans.
 *
 * Nothing here may throw into the host app: every extractor swallows errors and
 * degrades to [].
 */
import { SpanKind, context as otelContext, trace } from "@opentelemetry/api";
import type { Span } from "@opentelemetry/api";
import type { EvalKitClient } from "../../core/client.js";
import { recordSimToolCall } from "../../core/simulation.js";

const ARGS_MAX = 32768;

export type NormalizedToolCall = {
  name: string;
  argsJson: string;
  id: string;
  result?: string;
};

function truncate(s: string): string {
  return s.length <= ARGS_MAX ? s : s.slice(0, ARGS_MAX) + "…";
}

function toJson(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value ?? {});
  } catch {
    return String(value);
  }
}

function safeParse(argsJson: string): Record<string, unknown> | undefined {
  try {
    const v = JSON.parse(argsJson);
    return v && typeof v === "object" ? (v as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

// ── Shape 1: OpenAI Chat Completions ─────────────────────────────────────────
export function fromOpenAIChat(result: any, _ts?: string): NormalizedToolCall[] {
  const out: NormalizedToolCall[] = [];
  try {
    for (const choice of result?.choices ?? []) {
      for (const tc of choice?.message?.tool_calls ?? []) {
        const name = tc?.function?.name ?? "";
        if (!name) continue;
        out.push({ name, argsJson: truncate(toJson(tc?.function?.arguments ?? "")), id: tc?.id ?? "" });
      }
    }
  } catch { /* never throw */ }
  return out;
}

// ── Shape 2: Anthropic content blocks ────────────────────────────────────────
export function fromAnthropicBlocks(blocks: any, _ts?: string): NormalizedToolCall[] {
  const out: NormalizedToolCall[] = [];
  try {
    for (const block of blocks ?? []) {
      if (block?.type !== "tool_use") continue;
      const name = block?.name ?? "";
      if (!name) continue;
      out.push({ name, argsJson: truncate(toJson(block?.input ?? {})), id: block?.id ?? "" });
    }
  } catch { /* never throw */ }
  return out;
}

// ── Shape 3: Google GenAI ────────────────────────────────────────────────────
export function fromGoogleParts(resp: any, _ts?: string): NormalizedToolCall[] {
  const out: NormalizedToolCall[] = [];
  try {
    const calls: Array<{ name?: string; args?: unknown; id?: string }> = [];
    if (Array.isArray(resp?.functionCalls)) {
      calls.push(...resp.functionCalls);
    } else {
      for (const cand of resp?.candidates ?? []) {
        for (const p of cand?.content?.parts ?? []) {
          if (p?.functionCall?.name) calls.push(p.functionCall);
        }
      }
    }
    let i = 0;
    for (const fc of calls) {
      const name = fc?.name ?? "";
      if (!name) continue;
      out.push({ name, argsJson: truncate(toJson(fc?.args ?? {})), id: fc?.id ?? `call_${i++}` });
    }
  } catch { /* never throw */ }
  return out;
}

// ── Shape 4: OpenAI Responses API ────────────────────────────────────────────
function responsesCitations(items: any[]): string {
  const citations: string[] = [];
  try {
    for (const item of items) {
      if (item?.type !== "message") continue;
      for (const block of item?.content ?? []) {
        for (const ann of block?.annotations ?? []) {
          if (ann?.type !== "url_citation") continue;
          const title = ann?.title ?? "";
          const url = ann?.url ?? "";
          if (url) citations.push(title ? `[${title}](${url})` : url);
        }
      }
    }
  } catch { /* never throw */ }
  return citations.slice(0, 10).join("\n");
}

export function fromOpenAIResponses(items: any, _ts?: string): NormalizedToolCall[] {
  const out: NormalizedToolCall[] = [];
  try {
    const arr: any[] = Array.isArray(items) ? items : [];
    const citation = responsesCitations(arr);
    for (const item of arr) {
      const itype: string = item?.type ?? "";
      if (itype === "function_call") {
        const name = item?.name ?? "";
        if (!name) continue;
        out.push({ name, argsJson: truncate(toJson(item?.arguments ?? "")), id: item?.call_id ?? item?.id ?? "" });
      } else if (itype && itype.endsWith("_call")) {
        const query = item?.action?.query ?? "";
        out.push({
          name: itype.slice(0, -5),
          argsJson: truncate(toJson(query)),
          id: item?.id ?? "",
          ...(citation ? { result: truncate(citation) } : {}),
        });
      }
    }
  } catch { /* never throw */ }
  return out;
}

// ── Shape 5: LangChain LLMResult ─────────────────────────────────────────────
export function fromLangChainResult(output: any, _ts?: string): NormalizedToolCall[] {
  const out: NormalizedToolCall[] = [];
  try {
    for (const batch of output?.generations ?? []) {
      for (const g of batch ?? []) {
        for (const tc of g?.message?.tool_calls ?? []) {
          const name = tc?.name ?? "";
          if (!name) continue;
          out.push({ name, argsJson: truncate(toJson(tc?.args ?? {})), id: tc?.id ?? "" });
        }
      }
    }
  } catch { /* never throw */ }
  return out;
}

export function emitToolCalls(client: EvalKitClient, llmSpan: Span, calls: NormalizedToolCall[]): void {
  if (!calls.length) return;
  const traceId = llmSpan.spanContext().traceId;
  const ctx = trace.setSpan(otelContext.active(), llmSpan);
  for (const c of calls) {
    if (!c.name) continue;
    const eventAttrs: Record<string, string> = {
      "gen_ai.tool.name": c.name,
      "gen_ai.tool.call.id": c.id,
      "gen_ai.tool.call.arguments": c.argsJson,
    };
    if (c.result != null) eventAttrs["gen_ai.tool.call.result"] = c.result;
    try { llmSpan.addEvent("gen_ai.tool.call", eventAttrs); } catch { /* never break tracing */ }
    try { recordSimToolCall(traceId, c.name, safeParse(c.argsJson)); } catch { /* never break tracing */ }
    try {
      const toolSpan = client.tracer.startSpan(
        c.name,
        {
          kind: SpanKind.INTERNAL,
          attributes: {
            "evalkit.span_type": "tool_call",
            ...eventAttrs,
            "tool.name": c.name,
            "tool.arguments": c.argsJson,
            ...(c.result != null ? { "tool.result": c.result } : {}),
          },
        },
        ctx,
      );
      toolSpan.end();
    } catch { /* never break tracing */ }
  }
}
