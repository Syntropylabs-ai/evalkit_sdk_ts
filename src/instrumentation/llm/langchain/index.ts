import { SpanKind, SpanStatusCode, context as otelContext, trace } from "@opentelemetry/api";
import type { Span, Context as OtelContext } from "@opentelemetry/api";
import type { EvalKitClient } from "../../../core/client.js";
import { recordSimToolCall } from "../../../core/simulation.js";
import { emitToolCalls, fromLangChainResult } from "../_toolcalls.js";
import { safeBody } from "../_body.js";
import { samplingAttrs, toolAttrs } from "../_request.js";
import { dynImport, getRequire } from "../../../utils/dynimport.js";
import { claimPatch } from "../../_patched.js";
import { setFrameworkModelRunClaimer } from "../../../core/framework-model-call.js";
import type { FrameworkModelRun } from "../../../core/framework-model-call.js";
import { takeGraphRoot } from "./langgraph.js";
import { beforeFlush } from "../../../core/flush-hooks.js";
import { boundedText, safeString } from "../../../core/serialize.js";
import { BoundedMap } from "../../../utils/bounded-map.js";
import { recordError } from "../../../core/exceptions.js";

function loadLangChainModule(specifier: string): any {
  try {
    return getRequire()(specifier);
  } catch {
    return undefined;
  }
}

const ATTR_MAX = 4096;

function truncate(v: unknown, limit = ATTR_MAX): string {
  if (typeof v === "string") return v.length > limit ? v.slice(0, limit) + "…" : v;
  try {
    return boundedText(v, limit) ?? "";
  } catch {
    const s = safeString(v);
    return s.length > limit ? s.slice(0, limit) + "…" : s;
  }
}

// Runs are kept from their start callback to their end callback. A run whose end LangChain never reports (a
// callback that threw, a graph abandoned mid-step) would otherwise stay for the life of the process.
const MAX_OPEN_RUNS = 10_000;
const RUN_TTL_MS = 60 * 60_000;

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

// invocation_params is the provider request each chat model builds, so it carries that
// provider's own spelling of the sampling keys and its own tool shape.
function invocationAttrs(extraParams: any): Record<string, number | string[]> {
  try {
    const inv = extraParams?.invocation_params ?? {};
    const generation = inv.generationConfig ?? inv.inferenceConfig ?? {};
    return {
      ...samplingAttrs({
        temperature: inv.temperature ?? generation.temperature,
        topP: inv.top_p ?? inv.topP ?? generation.topP,
        maxTokens:
          inv.max_tokens ?? inv.maxTokens ?? inv.max_completion_tokens ?? inv.max_output_tokens ??
          inv.maxOutputTokens ?? generation.maxOutputTokens ?? generation.maxTokens,
      }),
      ...toolAttrs(inv.tools, inv.toolConfig?.tools),
    };
  } catch {
    return {};
  }
}

/** Where in a LangGraph run a span sits, from the metadata LangGraph gives every run inside a node. The
 * triggers go out as a compact JSON array, the same string the Python SDK writes for them. */
function langgraphAttrs(metadata: any): Record<string, string | number> {
  const out: Record<string, string | number> = {};
  try {
    if (!metadata || typeof metadata !== "object") return out;
    if (metadata.langgraph_node) out["langgraph.node"] = String(metadata.langgraph_node);
    if (Number.isInteger(metadata.langgraph_step)) out["langgraph.step"] = metadata.langgraph_step;
    const raw = metadata.langgraph_triggers;
    const triggers = typeof raw === "string" ? [raw] : raw;
    if (Array.isArray(triggers) && triggers.length > 0) {
      out["langgraph.triggers"] = JSON.stringify(triggers.map((t) => String(t)));
    }
    if (metadata.langgraph_checkpoint_ns) out["langgraph.checkpoint_ns"] = String(metadata.langgraph_checkpoint_ns);
  } catch {
    return {};
  }
  return out;
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

// A chat model's run waits for its end before it is recorded: a provider call made inside it claims it, and
// the provider's span is then the record, in the run's place and with its LangGraph attributes.
type PendingModelRun = {
  runId: string;
  leave?: () => void;
  parentRunId: string | undefined;
  parentCtx: OtelContext;
  name: string;
  attributes: Record<string, string | number | boolean | string[]>;
  langgraph: Record<string, string | number>;
  startTime: Date;
  claimed: boolean;
};

const openModelRuns = new BoundedMap<string, PendingModelRun>(MAX_OPEN_RUNS, RUN_TTL_MS);

const LC_STORAGE = Symbol.for("ls:tracing_async_local_storage");
const LC_CHILD_CONFIG = Symbol.for("lc:child_config");

/** The run LangChain is executing in this async context (a LangGraph node), from LangChain's own storage. */
function currentLangChainParentRunId(): string | undefined {
  try {
    const storage = (globalThis as Record<symbol, any>)[LC_STORAGE];
    const config = storage?.getStore?.()?.extra?.[LC_CHILD_CONFIG];
    const id = config?.callbacks?.getParentRunId?.();
    return typeof id === "string" ? id : undefined;
  } catch {
    return undefined;
  }
}

function claimOpenModelRun(): FrameworkModelRun | undefined {
  if (openModelRuns.size === 0) return undefined;
  const parent = currentLangChainParentRunId();
  const open = openModelRuns.values().filter((run) => !run.claimed);
  const candidates = parent !== undefined ? open.filter((run) => run.parentRunId === parent) : open;
  // Without LangChain's context to tell runs apart, only a single open run is taken.
  if (candidates.length === 0 || (parent === undefined && candidates.length > 1)) return undefined;
  const run = candidates[0];
  run.claimed = true;
  return { ctx: run.parentCtx, attributes: run.langgraph };
}

setFrameworkModelRunClaimer(claimOpenModelRun);

// How long a root opened for runs whose parent was never seen stays open after its last run ended, for the
// graph's next step to join it.
const ADOPTED_ROOT_IDLE_MS = 1000;

type AdoptedRoot = { span: Span; ctx: OtelContext; open: Set<string>; lastEnd: Date; lastStep: number; timer?: ReturnType<typeof setTimeout> };

// The key of the root shared by graph steps that reached the handler with no parent run at all: a graph
// invoked before the handler was attached reports its steps that way.
const UNPARENTED_GRAPH = "\u0000unparented-graph";

export function langchainHandlerMethods(client: EvalKitClient): Record<string, (...args: any[]) => void> {
  const runs = new BoundedMap<string, { span: Span; ctx: OtelContext; owned: boolean; root?: AdoptedRoot }>(MAX_OPEN_RUNS, RUN_TTL_MS);
  // Runs whose parent run started before this handler was attached (in an ES module app, a graph invoked
  // straight after its imports runs before the SDK's patches land) share one root per unseen parent, so a
  // graph's steps stay one trace. A root that outlives the cap or the TTL is ended where it stands.
  const adopted = new BoundedMap<string, AdoptedRoot>(MAX_OPEN_RUNS, RUN_TTL_MS, (_id, root) => {
    if (root.timer) clearTimeout(root.timer);
    try {
      root.span.end(root.lastEnd);
    } catch {  }
  });

  function endAdopted(parentRunId: string, root: AdoptedRoot): void {
    if (root.timer) clearTimeout(root.timer);
    adopted.delete(parentRunId);
    try {
      root.span.setStatus({ code: SpanStatusCode.OK });
      root.span.end(root.lastEnd);
    } catch {  }
  }

  beforeFlush(() => {
    for (const [id, root] of adopted.entriesList()) if (root.open.size === 0) endAdopted(id, root);
  });

  function adoptedRoot(parentRunId: string, inGraph: boolean): AdoptedRoot {
    let root = adopted.get(parentRunId);
    if (!root) {
      const name = inGraph ? "LangGraph" : "LangChain";
      const span = client.tracer.startSpan(name, {
        kind: SpanKind.INTERNAL,
        attributes: { "evalkit.span_type": "function_call", "evalkit.framework": name === "LangGraph" ? "langgraph" : "langchain" },
      }, otelContext.active());
      root = { span, ctx: trace.setSpan(otelContext.active(), span), open: new Set(), lastEnd: new Date(), lastStep: -1 };
      adopted.set(parentRunId, root);
    }
    return root;
  }

  /** The context a run starts in: its parent run's, an adopted root's, or the app's. */
  function placeRun(runId: string, parentRunId: string | undefined, inGraph: boolean, step?: unknown): { ctx: OtelContext; root?: AdoptedRoot } {
    const parent = parentRunId ? runs.get(parentRunId) : undefined;
    if (parent) return { ctx: parent.ctx };
    if (trace.getActiveSpan()?.isRecording()) return { ctx: otelContext.active() };
    // Steps that come without a parent belong to one invocation while they keep coming; a step number lower
    // than the last one is the next invocation.
    const key = parentRunId ?? (inGraph ? UNPARENTED_GRAPH : undefined);
    if (key) {
      const current = adopted.get(key);
      if (current && typeof step === "number" && step < current.lastStep && key === UNPARENTED_GRAPH) endAdopted(key, current);
      const root = adoptedRoot(key, inGraph);
      if (typeof step === "number") root.lastStep = Math.max(root.lastStep, step);
      if (root.timer) { clearTimeout(root.timer); root.timer = undefined; }
      root.open.add(runId);
      return { ctx: root.ctx, root };
    }
    return { ctx: otelContext.active() };
  }

  function leaveRoot(runId: string, root: AdoptedRoot | undefined): void {
    if (!root || !root.open.delete(runId)) return;
    root.lastEnd = new Date();
    if (root.open.size > 0) return;
    for (const [id, r] of adopted.entriesList()) {
      if (r !== root) continue;
      root.timer = setTimeout(() => endAdopted(id, root), ADOPTED_ROOT_IDLE_MS);
      (root.timer as { unref?: () => void }).unref?.();
    }
  }


  function startRun(
    runId: string,
    parentRunId: string | undefined,
    spanType: string,
    name: string,
    attributes: Record<string, string | number | boolean | string[]>,
  ): void {
    try {
      const placed = placeRun(runId, parentRunId, "langgraph.node" in attributes, attributes["langgraph.step"]);
      const parentCtx = placed.ctx;
      // The graph's own run, which has no parent, inside the root span the SDK opened for the invocation, is
      // that span.
      if (spanType === "function_call" && !parentRunId) {
        const root = trace.getSpan(parentCtx);
        if (root && takeGraphRoot(root)) {
          root.setAttributes(attributes);
          runs.set(runId, { span: root, ctx: parentCtx, owned: false });
          return;
        }
      }
      const span = client.tracer.startSpan(
        name,
        { kind: spanType === "llm_call" ? SpanKind.CLIENT : SpanKind.INTERNAL, attributes: { "evalkit.span_type": spanType, "evalkit.framework": "langchain", ...attributes } },
        parentCtx,
      );
      runs.set(runId, { span, ctx: trace.setSpan(parentCtx, span), owned: true, root: placed.root });
    } catch {  }
  }

  function endRun(runId: string, status: "OK" | "ERROR", attrs?: Record<string, string | number | boolean>, error?: unknown): void {
    try {
      const rec = runs.get(runId);
      if (!rec) return;
      runs.delete(runId);
      leaveRoot(runId, rec.root);
      if (!rec.owned) return;
      if (attrs) rec.span.setAttributes(attrs);
      // A run's error reaches the code that invoked the chain, tool or retriever.
      if (error !== undefined) recordError(rec.span, error, { escaped: true });
      else rec.span.setStatus({ code: status === "OK" ? SpanStatusCode.OK : SpanStatusCode.ERROR });
      rec.span.end();
    } catch {  }
  }

  function startModelRun(
    runId: string,
    parentRunId: string | undefined,
    name: string,
    attributes: Record<string, string | number | boolean | string[]>,
    metadata: any,
  ): void {
    try {
      const langgraph = langgraphAttrs(metadata);
      const placed = placeRun(runId, parentRunId, "langgraph.node" in langgraph, langgraph["langgraph.step"]);
      openModelRuns.set(runId, {
        runId,
        leave: () => leaveRoot(runId, placed.root),
        parentRunId,
        parentCtx: placed.ctx,
        name,
        attributes: { ...attributes, ...langgraph },
        langgraph,
        startTime: new Date(),
        claimed: false,
      });
    } catch {  }
  }

  /** The model run's span, recorded now that it ended, unless a provider call recorded it. */
  function endModelRun(
    runId: string,
    status: "OK" | "ERROR",
    attrs?: Record<string, string | number | boolean>,
    error?: unknown,
    output?: any,
  ): void {
    try {
      const run = openModelRuns.get(runId);
      if (!run) return;
      openModelRuns.delete(runId);
      run.leave?.();
      if (run.claimed) return;
      const span = client.tracer.startSpan(
        run.name,
        { kind: SpanKind.CLIENT, startTime: run.startTime, attributes: { "evalkit.span_type": "llm_call", "evalkit.framework": "langchain", ...run.attributes } },
        run.parentCtx,
      );
      if (attrs) span.setAttributes(attrs);
      if (output !== undefined) {
        try { emitToolCalls(client, span, fromLangChainResult(output)); } catch {  }
      }
      if (error !== undefined) recordError(span, error, { escaped: true });
      else span.setStatus({ code: status === "OK" ? SpanStatusCode.OK : SpanStatusCode.ERROR });
      span.end();
    } catch {  }
  }

  return {
    handleChainStart(chain: any, _inputs: any, runId: string, parentRunId?: string, tags?: string[], metadata?: any, _runType?: string, name?: string) {
      const label = name ?? chain?.id?.[chain.id.length - 1] ?? "chain";
      startRun(runId, parentRunId, "function_call", String(label), {
        ...(tags?.length ? { "langchain.tags": tags.join(",") } : {}),
        ...langgraphAttrs(metadata),
      });
    },
    handleChainEnd(_outputs: any, runId: string) { endRun(runId, "OK"); },
    handleChainError(err: any, runId: string) { endRun(runId, "ERROR", undefined, err ?? new Error("chain failed")); },

    handleLLMStart(llm: any, prompts: string[], runId: string, parentRunId?: string, extraParams?: any, _tags?: string[], metadata?: any) {
      const model = modelFrom(llm, extraParams);
      const reqBody = safeBody({ prompts: prompts ?? [], invocation_params: extraParams?.invocation_params });
      startModelRun(runId, parentRunId, "llm.generate", {
        "gen_ai.request.model": model,
        "gen_ai.system": providerFrom(llm) ?? "",
        ...invocationAttrs(extraParams),
        "evalkit.prompt": truncate((prompts ?? []).join("\n")),
        ...(reqBody ? { "gen_ai.request.body": reqBody } : {}),
      }, metadata);
    },
    handleChatModelStart(llm: any, messages: any, runId: string, parentRunId?: string, extraParams?: any, _tags?: string[], metadata?: any) {
      const model = modelFrom(llm, extraParams);
      const reqBody = safeBody({ messages, invocation_params: extraParams?.invocation_params });
      startModelRun(runId, parentRunId, "chat.generate", {
        "gen_ai.request.model": model,
        "gen_ai.system": providerFrom(llm) ?? "",
        ...invocationAttrs(extraParams),
        "evalkit.prompt": messagesToPrompt(messages),
        ...(reqBody ? { "gen_ai.request.body": reqBody } : {}),
      }, metadata);
    },
    handleLLMEnd(output: any, runId: string) {
      const pending = openModelRuns.get(runId);
      if (pending?.claimed) {
        openModelRuns.delete(runId);
        pending.leave?.();
        return;
      }
      const { tin, tout } = llmResultTokens(output);
      const respBody = safeBody(output);
      endModelRun(runId, "OK", {
        "evalkit.completion": llmResultCompletion(output),
        "gen_ai.usage.input_tokens": tin,
        "gen_ai.usage.output_tokens": tout,
        "gen_ai.usage.total_tokens": tin + tout,
        ...(respBody ? { "gen_ai.response.body": respBody } : {}),
      }, undefined, output);
    },
    handleLLMError(err: any, runId: string) { endModelRun(runId, "ERROR", undefined, err ?? new Error("model call failed")); },

    handleToolStart(tool: any, input: string, runId: string, parentRunId?: string, _tags?: string[], metadata?: any, name?: string) {
      const label = name ?? tool?.id?.[tool.id.length - 1] ?? "tool";
      const rec = runs.get(parentRunId ?? "");
      recordSimToolCall(rec?.span.spanContext().traceId, String(label));
      startRun(runId, parentRunId, "tool_call", String(label), {
        "tool.name": String(label),
        "tool.arguments": truncate(input),
        ...langgraphAttrs(metadata),
      });
    },
    handleToolEnd(output: any, runId: string) { endRun(runId, "OK", { "tool.result": truncate(output) }); },
    handleToolError(err: any, runId: string) { endRun(runId, "ERROR", undefined, err ?? new Error("tool failed")); },

    handleRetrieverStart(retriever: any, query: string, runId: string, parentRunId?: string, _tags?: string[], metadata?: any) {
      const label = retriever?.id?.[retriever.id.length - 1] ?? "retriever";
      startRun(runId, parentRunId, "db_query", String(label), { "retriever.query": truncate(query), ...langgraphAttrs(metadata) });
    },
    handleRetrieverEnd(documents: any, runId: string) {
      const count = Array.isArray(documents) ? documents.length : 0;
      endRun(runId, "OK", { "retriever.document_count": count });
    },
    handleRetrieverError(err: any, runId: string) { endRun(runId, "ERROR", undefined, err ?? new Error("retriever failed")); },
  };
}

export async function langchainCallbackHandler(client: EvalKitClient): Promise<any | null> {
  try {
    const base: any = loadLangChainModule("@langchain/core/callbacks/base") ?? await dynImport("@langchain/core/callbacks/base");
    const handler = base.BaseCallbackHandler.fromMethods(langchainHandlerMethods(client));
    (handler as any).name = "evalkit";
    // Awaited, so a model run is noted before the provider call it makes can look for it. The handler's
    // methods do no I/O, so awaiting them costs nothing.
    (handler as any).awaitHandlers = true;
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
    if (CM && typeof CM._configureSync === "function" && !(CM as any).__evalkitPatched && claimPatch(CM, "_configureSync")) {
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
