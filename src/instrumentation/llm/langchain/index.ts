import { SpanKind, SpanStatusCode, context as otelContext, trace } from "@opentelemetry/api";
import type { Span, Context as OtelContext } from "@opentelemetry/api";
import type { EvalKitClient } from "../../../core/client.js";
import { recordSimToolCall } from "../../../core/simulation.js";
import { emitToolCalls, fromLangChainResult } from "../_toolcalls.js";
import { safeBody } from "../_body.js";
import { dynImport, getRequire } from "../../../utils/dynimport.js";

function loadLangChainModule(specifier: string): any {
  try {
    return getRequire()(specifier);
  } catch {
    return undefined;
  }
}

const ATTR_MAX = 4096;

function truncate(v: unknown, limit = ATTR_MAX): string {
  let s: string;
  try { s = typeof v === "string" ? v : JSON.stringify(v); } catch { s = String(v); }
  if (s === undefined || s === null) return "";
  return s.length > limit ? s.slice(0, limit) + "…" : s;
}

function providerFrom(serialized: any): string | undefined {
  const id = serialized?.id;
  if (Array.isArray(id)) {
    for (const token of ["openai", "anthropic", "google", "vertexai", "cohere", "mistral", "bedrock", "ollama", "groq"]) {
      if (id.includes(token)) return token === "vertexai" ? "vertex-ai" : token;
    }
    return id[id.length - 1];
  }
  return undefined;
}

function modelFrom(serialized: any, extraParams: any): string {
  const inv = extraParams?.invocation_params ?? {};
  for (const k of ["model", "model_name", "modelName", "model_id", "deployment_name"]) {
    if (inv[k]) return String(inv[k]);
  }
  const kw = serialized?.kwargs ?? {};
  for (const k of ["model", "model_name", "modelName", "model_id"]) {
    if (kw[k]) return String(kw[k]);
  }
  return "unknown";
}

function messagesToPrompt(messages: any): string {
  try {
    const batch = Array.isArray(messages?.[0]) ? messages[0] : messages;
    const lines = (batch ?? []).map((m: any) => {
      const role = (typeof m?._getType === "function" ? m._getType() : undefined) ?? m?.role ?? m?.type ?? "message";
      const content = typeof m?.content === "string" ? m.content : truncate(m?.content);
      return `${role}: ${content}`;
    });
    return truncate(lines.join("\n"));
  } catch {
    return truncate(messages);
  }
}

function llmResultCompletion(output: any): string {
  try {
    const parts: string[] = [];
    for (const batch of output?.generations ?? []) {
      for (const g of batch ?? []) {
        if (g?.text) parts.push(String(g.text));
        else if (g?.message?.content) parts.push(typeof g.message.content === "string" ? g.message.content : truncate(g.message.content));
      }
    }
    return truncate(parts.filter(Boolean).join("\n"));
  } catch {
    return "";
  }
}

function llmResultTokens(output: any): { tin: number; tout: number } {
  let tin = 0;
  let tout = 0;
  try {
    const usage = output?.llmOutput?.tokenUsage ?? output?.llmOutput?.usage ?? {};
    tin = usage.promptTokens ?? usage.prompt_tokens ?? usage.input_tokens ?? 0;
    tout = usage.completionTokens ?? usage.completion_tokens ?? usage.output_tokens ?? 0;
    if (!tin && !tout) {
      for (const batch of output?.generations ?? []) {
        for (const g of batch ?? []) {
          const um = g?.message?.usage_metadata;
          if (um) { tin = um.input_tokens ?? tin; tout = um.output_tokens ?? tout; }
        }
      }
    }
  } catch {  }
  return { tin: tin || 0, tout: tout || 0 };
}

export function langchainHandlerMethods(client: EvalKitClient): Record<string, (...args: any[]) => void> {
  const runs = new Map<string, { span: Span; ctx: OtelContext }>();

  function startRun(
    runId: string,
    parentRunId: string | undefined,
    spanType: string,
    name: string,
    attributes: Record<string, string | number | boolean>,
  ): void {
    try {
      const parent = parentRunId ? runs.get(parentRunId) : undefined;
      const parentCtx = parent ? parent.ctx : otelContext.active();
      const span = client.tracer.startSpan(
        name,
        { kind: spanType === "llm_call" ? SpanKind.CLIENT : SpanKind.INTERNAL, attributes: { "evalkit.span_type": spanType, "evalkit.framework": "langchain", ...attributes } },
        parentCtx,
      );
      runs.set(runId, { span, ctx: trace.setSpan(parentCtx, span) });
    } catch {  }
  }

  function endRun(runId: string, status: "OK" | "ERROR", attrs?: Record<string, string | number | boolean>, message?: string): void {
    try {
      const rec = runs.get(runId);
      if (!rec) return;
      runs.delete(runId);
      if (attrs) rec.span.setAttributes(attrs);
      rec.span.setStatus({ code: status === "OK" ? SpanStatusCode.OK : SpanStatusCode.ERROR, message });
      rec.span.end();
    } catch {  }
  }

  return {
    handleChainStart(chain: any, _inputs: any, runId: string, parentRunId?: string, tags?: string[], _metadata?: any, _runType?: string, name?: string) {
      const label = name ?? chain?.id?.[chain.id.length - 1] ?? "chain";
      startRun(runId, parentRunId, "function_call", String(label), tags?.length ? { "langchain.tags": tags.join(",") } : {});
    },
    handleChainEnd(_outputs: any, runId: string) { endRun(runId, "OK"); },
    handleChainError(err: any, runId: string) { endRun(runId, "ERROR", undefined, String(err?.message ?? err)); },

    handleLLMStart(llm: any, prompts: string[], runId: string, parentRunId?: string, extraParams?: any) {
      const model = modelFrom(llm, extraParams);
      const reqBody = safeBody({ prompts: prompts ?? [], invocation_params: extraParams?.invocation_params });
      startRun(runId, parentRunId, "llm_call", "llm.generate", {
        "gen_ai.request.model": model,
        "gen_ai.system": providerFrom(llm) ?? "",
        "evalkit.prompt": truncate((prompts ?? []).join("\n")),
        ...(reqBody ? { "gen_ai.request.body": reqBody } : {}),
      });
    },
    handleChatModelStart(llm: any, messages: any, runId: string, parentRunId?: string, extraParams?: any) {
      const model = modelFrom(llm, extraParams);
      const reqBody = safeBody({ messages, invocation_params: extraParams?.invocation_params });
      startRun(runId, parentRunId, "llm_call", "chat.generate", {
        "gen_ai.request.model": model,
        "gen_ai.system": providerFrom(llm) ?? "",
        "evalkit.prompt": messagesToPrompt(messages),
        ...(reqBody ? { "gen_ai.request.body": reqBody } : {}),
      });
    },
    handleLLMEnd(output: any, runId: string) {
      const { tin, tout } = llmResultTokens(output);
      const rec = runs.get(runId);

      try {
        if (rec) emitToolCalls(client, rec.span, fromLangChainResult(output));
      } catch {  }
      const respBody = safeBody(output);
      endRun(runId, "OK", {
        "evalkit.completion": llmResultCompletion(output),
        "gen_ai.usage.input_tokens": tin,
        "gen_ai.usage.output_tokens": tout,
        "gen_ai.usage.total_tokens": tin + tout,
        ...(respBody ? { "gen_ai.response.body": respBody } : {}),
      });
    },
    handleLLMError(err: any, runId: string) { endRun(runId, "ERROR", undefined, String(err?.message ?? err)); },

    handleToolStart(tool: any, input: string, runId: string, parentRunId?: string, _tags?: string[], _metadata?: any, name?: string) {
      const label = name ?? tool?.id?.[tool.id.length - 1] ?? "tool";
      const rec = runs.get(parentRunId ?? "");
      recordSimToolCall(rec?.span.spanContext().traceId, String(label));
      startRun(runId, parentRunId, "tool_call", String(label), { "tool.name": String(label), "tool.arguments": truncate(input) });
    },
    handleToolEnd(output: any, runId: string) { endRun(runId, "OK", { "tool.result": truncate(output) }); },
    handleToolError(err: any, runId: string) { endRun(runId, "ERROR", undefined, String(err?.message ?? err)); },

    handleRetrieverStart(retriever: any, query: string, runId: string, parentRunId?: string) {
      const label = retriever?.id?.[retriever.id.length - 1] ?? "retriever";
      startRun(runId, parentRunId, "db_query", String(label), { "retriever.query": truncate(query) });
    },
    handleRetrieverEnd(documents: any, runId: string) {
      const count = Array.isArray(documents) ? documents.length : 0;
      endRun(runId, "OK", { "retriever.document_count": count });
    },
    handleRetrieverError(err: any, runId: string) { endRun(runId, "ERROR", undefined, String(err?.message ?? err)); },
  };
}

export async function langchainCallbackHandler(client: EvalKitClient): Promise<any | null> {
  try {
    const base: any = loadLangChainModule("@langchain/core/callbacks/base") ?? await dynImport("@langchain/core/callbacks/base");
    const handler = base.BaseCallbackHandler.fromMethods(langchainHandlerMethods(client));
    (handler as any).name = "evalkit";
    (handler as any).__evalkit = true;
    return handler;
  } catch {
    return null;
  }
}

export async function patchLangChain(client: EvalKitClient): Promise<any | null> {
  const handler = await langchainCallbackHandler(client);
  if (!handler) return null;
  try {
    const mgrMod: any = loadLangChainModule("@langchain/core/callbacks/manager") ?? await dynImport("@langchain/core/callbacks/manager");
    const CM = mgrMod.CallbackManager;
    if (CM && typeof CM._configureSync === "function" && !(CM as any).__evalkitPatched) {
      const original = CM._configureSync.bind(CM);

      CM._configureSync = function (this: any, inheritableHandlers: any, ...rest: any[]) {
        try {
          if (Array.isArray(inheritableHandlers) || !inheritableHandlers) {
            const handlers = inheritableHandlers ? [...inheritableHandlers] : [];
            if (!handlers.includes(handler)) handlers.unshift(handler);
            return original.call(this, handlers, ...rest);
          }
          if (typeof inheritableHandlers.addHandler === "function") {
            if (!inheritableHandlers.handlers?.includes(handler)) {
              inheritableHandlers.addHandler(handler, true);
            }
          }
        } catch {  }
        return original.call(this, inheritableHandlers, ...rest);
      };
      (CM as any).__evalkitPatched = true;
    }
  } catch {  }
  return handler;
}
