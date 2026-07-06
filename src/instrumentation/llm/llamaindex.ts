import { SpanKind, SpanStatusCode, context as otelContext, trace } from "@opentelemetry/api";
import type { Span, Context as OtelContext } from "@opentelemetry/api";
import type { EvalKitClient } from "../../core/client.js";
import { safeBody } from "./_body.js";

// LlamaIndex.TS instrumentation via its native Settings.callbackManager event bus.
//
// Unlike the Python package (separate Event + Span layers via a dispatcher),
// LlamaIndex.TS uses one flat event system: a global `Settings.callbackManager`
// (EventTarget-like `.on(type, handler)`) dispatching typed events (llm-start/end,
// retrieve-start/end, query-start/end, ...).
//
// Two different ids matter here and must NOT be conflated:
//   - `event.detail.id` — a fresh UUID per *event pair* (query-start/query-end
//     share one, retrieve-start/retrieve-end share a different one, even when
//     they occur inside the same query() call). This is what start()/end() key
//     their records by, since it's the only id guaranteed distinct per operation.
//   - `event.reason` — an EventCaller identifying the enclosing *call frame*
//     (e.g. one `RetrieverQueryEngine.query()` invocation). Confirmed by runtime
//     probing: query-start, retrieve-start, retrieve-end, synthesize-start/end
//     and query-end ALL share the SAME `reason.id` for one query() call — LlamaIndex
//     doesn't open a new EventCaller frame per sub-operation, only per top-level
//     entry point. So `reason.id` cannot be used as the record key (an earlier
//     version of this file did, and silently corrupted the query span with
//     retrieve's data instead of creating a separate one — caught via a live
//     end-to-end RAG pipeline test, not a mocked one).
//
// Hierarchy is resolved via a per-reason stack of currently-open records: sibling
// sub-operations under the same reason (retrieve, then synthesize) nest under
// whatever is topmost on that reason's stack, and a genuinely nested EventCaller
// (reason.parent set) falls back to its parent frame's stack.
//
// There's no span_drop equivalent here: a call that throws never dispatches its
// matching *-end event, so a thrown error currently leaks that one open span
// rather than closing it as ERROR. LlamaIndex.TS exposes no lower-level signal to
// hook that (unlike the Python dispatcher's span layer) — accepted as a known gap
// rather than worked around with something fragile.
//
// Never captures raw embedding vectors. Degrades to a no-op if `llamaindex`
// isn't installed and never throws into the caller.

type Rec = { span: Span; ctx: OtelContext; reasonId: string | undefined };

function messagesToText(messages: any[] = []): string {
  try {
    return messages
      .map((m) => `${m?.role}: ${typeof m?.content === "string" ? m.content : JSON.stringify(m?.content ?? "")}`)
      .join("\n");
  } catch {
    return "";
  }
}

function extractTokens(raw: any): { tin: number; tout: number } {
  let tin = 0;
  let tout = 0;
  try {
    const usage = raw?.usage ?? {};
    tin = usage.promptTokens ?? usage.prompt_tokens ?? usage.input_tokens ?? 0;
    tout = usage.completionTokens ?? usage.completion_tokens ?? usage.output_tokens ?? 0;
  } catch { /* ignore */ }
  return { tin: tin || 0, tout: tout || 0 };
}

function nodesSummary(nodes: any[] = []): Array<{ id: any; score: any }> {
  try {
    return (nodes ?? []).map((n) => ({ id: n?.node?.id_ ?? n?.id_, score: n?.score }));
  } catch {
    return [];
  }
}

function queryText(query: any): string {
  try {
    if (typeof query === "string") return query;
    if (typeof query?.query === "string") return query.query;
    return JSON.stringify(query ?? "");
  } catch {
    return "";
  }
}

export function patchLlamaIndex(client: EvalKitClient, mod: any): void {
  const Settings = mod?.Settings;
  const cb = Settings?.callbackManager;
  if (!cb || typeof cb.on !== "function" || cb.__evalkitPatched) return;

  // Keyed by event.detail.id (see the module comment for why NOT reason.id).
  const records = new Map<string, Rec>();
  // Keyed by reason.id: the stack of currently-open records opened under that
  // EventCaller frame, topmost = innermost active sub-operation.
  const reasonStacks = new Map<string, Rec[]>();

  function resolveParentCtx(reason: any): OtelContext {
    let walk = reason ?? null;
    while (walk) {
      const stack = reasonStacks.get(walk.id);
      if (stack && stack.length) return stack[stack.length - 1].ctx;
      walk = walk.parent ?? null;
    }
    return otelContext.active();
  }

  function start(reason: any, detailId: string | undefined, spanType: string, name: string, attrs: Record<string, any>): void {
    try {
      if (!detailId || records.has(detailId)) return;
      const parentCtx = resolveParentCtx(reason);
      const span = client.tracer.startSpan(
        name,
        {
          kind: spanType === "llm_call" ? SpanKind.CLIENT : SpanKind.INTERNAL,
          attributes: { "evalkit.span_type": spanType, "evalkit.framework": "llamaindex", ...attrs },
        },
        parentCtx,
      );
      const rec: Rec = { span, ctx: trace.setSpan(parentCtx, span), reasonId: reason?.id };
      records.set(detailId, rec);
      if (reason?.id) {
        const stack = reasonStacks.get(reason.id) ?? [];
        stack.push(rec);
        reasonStacks.set(reason.id, stack);
      }
    } catch { /* never break the caller */ }
  }

  function end(detailId: string | undefined, status: "OK" | "ERROR", attrs?: Record<string, any>): void {
    try {
      if (!detailId) return;
      const rec = records.get(detailId);
      if (!rec) return;
      records.delete(detailId);
      if (rec.reasonId) {
        const stack = reasonStacks.get(rec.reasonId);
        if (stack) {
          const idx = stack.lastIndexOf(rec);
          if (idx !== -1) stack.splice(idx, 1);
          if (stack.length === 0) reasonStacks.delete(rec.reasonId);
        }
      }
      if (attrs) rec.span.setAttributes(attrs);
      rec.span.setStatus({ code: status === "OK" ? SpanStatusCode.OK : SpanStatusCode.ERROR });
      rec.span.end();
    } catch { /* never break the caller */ }
  }

  cb.on("llm-start", (event: any) => {
    const { id, messages } = event?.detail ?? {};
    const reqBody = safeBody(messages);
    start(event?.reason, id, "llm_call", "chat", {
      "gen_ai.system": "llamaindex",
      "evalkit.prompt": messagesToText(messages),
      ...(reqBody ? { "gen_ai.request.body": reqBody } : {}),
    });
  });

  cb.on("llm-end", (event: any) => {
    const { id, response } = event?.detail ?? {};
    const content = typeof response?.message?.content === "string" ? response.message.content : "";
    const { tin, tout } = extractTokens(response?.raw);
    const respBody = safeBody(response?.raw ?? response);
    end(id, "OK", {
      "evalkit.completion": content,
      "gen_ai.usage.input_tokens": tin,
      "gen_ai.usage.output_tokens": tout,
      ...(respBody ? { "gen_ai.response.body": respBody } : {}),
    });
  });

  cb.on("retrieve-start", (event: any) => {
    const { id, query } = event?.detail ?? {};
    start(event?.reason, id, "db_query", "retrieve", { "evalkit.prompt": queryText(query) });
  });

  cb.on("retrieve-end", (event: any) => {
    const { id, nodes } = event?.detail ?? {};
    const matches = nodesSummary(nodes);
    const respBody = safeBody({ matches });
    end(id, "OK", {
      "db.vector.match_count": matches.length,
      ...(respBody ? { "gen_ai.response.body": respBody } : {}),
    });
  });

  cb.on("query-start", (event: any) => {
    const { id, query } = event?.detail ?? {};
    start(event?.reason, id, "function_call", "query", { "evalkit.prompt": queryText(query) });
  });

  cb.on("query-end", (event: any) => {
    const { id, response } = event?.detail ?? {};
    if (response && typeof (response as any)[Symbol.asyncIterator] === "function") {
      // Streaming query response — content isn't available synchronously here.
      end(id, "OK", { "gen_ai.streaming": true });
      return;
    }
    const content =
      typeof response?.message?.content === "string" ? response.message.content
      : typeof response?.response === "string" ? response.response
      : "";
    const sourceNodes = response?.sourceNodes ?? [];
    end(id, "OK", {
      "evalkit.completion": content,
      "rag.source_node_count": Array.isArray(sourceNodes) ? sourceNodes.length : 0,
    });
  });

  cb.__evalkitPatched = true;
}
