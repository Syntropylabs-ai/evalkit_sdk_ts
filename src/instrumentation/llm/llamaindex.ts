import { SpanKind, SpanStatusCode, context as otelContext, trace } from "@opentelemetry/api";
import type { Span, Context as OtelContext } from "@opentelemetry/api";
import type { EvalKitClient } from "../../core/client.js";
import { safeBody } from "./_body.js";
import { claimPatch } from "../_patched.js";

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
  } catch {  }
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
  if (!claimPatch(cb, "on")) return;

  const records = new Map<string, Rec>();

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
    } catch {  }
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
    } catch {  }
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
