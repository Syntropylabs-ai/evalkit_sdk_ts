import { SpanKind, SpanStatusCode, type Span } from "@opentelemetry/api";
import type { EvalKitClient } from "../core/client.js";

const IO_MAX = 8192;

function toJson(v: unknown): string {
  if (typeof v === "string") return v;
  try { return JSON.stringify(v ?? {}); } catch { return String(v); }
}

function truncate(s: string): string {
  return s.length <= IO_MAX ? s : s.slice(0, IO_MAX) + "…";
}

type ToolLike = { name?: string; description?: string };
type ContentPart = { text?: string; functionCall?: { name?: string; args?: unknown } };
type ContentLike = { parts?: ContentPart[] } | undefined;
type EventLike = { author?: string; timestamp?: number; content?: ContentLike };
type ParentContextLike = { userContent?: ContentLike; session?: { events?: EventLike[] } };

function textOf(content: ContentLike): string {
  const parts = content?.parts ?? [];
  return parts.map((p) => p.text ?? "").join("");
}

/**
 * Instrumentation for Google ADK (Agent Development Kit) — the JS/TS SDK
 * (`@google/adk`, a separate package from Python's `google-adk`).
 *
 * Two spans come from this:
 *
 *   - `tool_call`, registered as an ADK Plugin (`BasePlugin` —
 *     google/adk-js core/src/plugins/base_plugin.ts, ADK's own documented
 *     extension mechanism). `beforeToolCallback`/`afterToolCallback`/
 *     `onToolErrorCallback` are wired all the way through in
 *     @google/adk@1.4.0 (confirmed by tracing plugin_manager.js's
 *     runBeforeToolCallback/runAfterToolCallback into agents/functions.js),
 *     so a real OTel span is started before the tool runs and ended after —
 *     exact latency, not a guessed duration.
 *
 *   - `function_call` (operation `run_agent`), from wrapping
 *     `BaseAgent.prototype.runAsync` directly instead of the plugin
 *     system's `beforeAgentCallback`/`afterAgentCallback`: those plugin
 *     hooks exist on `BasePlugin` and `PluginManager.runBeforeAgentCallback`/
 *     `runAfterAgentCallback` are implemented, but nothing in Runner or the
 *     agents actually calls them in this version (verified: those two
 *     PluginManager methods have zero call sites anywhere else in the
 *     package) — an incomplete wire-up in a package published only a day
 *     before this was written, not a Plugin misuse on our part. `runAsync`
 *     is the one method every agent type funnels through regardless
 *     (LlmAgent and friends override `runAsyncImpl`, not `runAsync`
 *     itself), so patching it once covers the root agent and every
 *     delegated sub-agent. The result text is read back from
 *     `session.events`: every event ADK appends carries `author` (the
 *     producing agent's name) and `timestamp`, so a nested sub-agent's own
 *     turn cleanly filters to just its own events instead of picking up its
 *     parent's or siblings'. Shaped to match the dashboard convention
 *     (trace-analysis.service.ts's `firstArg`/`extractAgentText`) the
 *     Python SDK's ADK integration and the simulation framework both use.
 *
 * `Runner`'s own exported class binding can't be reassigned (its bundler's
 * re-export helper defines it as a getter with no setter — `Object.defineProperty`
 * without `configurable`, so even redefining it throws), which is why this
 * patches `Runner.prototype`/`BaseAgent.prototype` in place rather than
 * subclassing and swapping the export, like every other patch in this file.
 *
 * LLM calls are not duplicated here: ADK's model calls go through
 * `@google/genai`, already patched separately (see llm/google-genai).
 */
export function patchGoogleAdk(client: EvalKitClient, adkModule: any): void {
  const Runner = adkModule?.Runner;
  const BaseAgent = adkModule?.BaseAgent;
  const BasePlugin = adkModule?.BasePlugin;
  if (!Runner?.prototype || !BaseAgent?.prototype || !BasePlugin) return;
  if ((Runner.prototype.runAsync as { __evalkit?: boolean })?.__evalkit) return;

  const toolSpans = new WeakMap<object, Span>();

  class EvalKitAdkPlugin extends BasePlugin {
    constructor() {
      super("evalkit");
    }

    async beforeToolCallback(params: {
      tool: ToolLike;
      toolArgs: Record<string, unknown>;
      toolContext: object;
    }): Promise<Record<string, unknown> | undefined> {
      try {
        const name = params.tool?.name ?? "tool";
        const argsJson = truncate(toJson(params.toolArgs ?? {}));
        const span = client.tracer.startSpan(name, {
          kind: SpanKind.INTERNAL,
          attributes: {
            "evalkit.span_type": "tool_call",
            "gen_ai.tool.name": name,
            "gen_ai.tool.description": params.tool?.description ?? "",
            "gen_ai.tool.call.arguments": argsJson,
          },
        });
        toolSpans.set(params.toolContext, span);
      } catch { /* tracing must never break the tool call */ }
      return undefined;
    }

    async afterToolCallback(params: {
      tool: ToolLike;
      toolArgs: Record<string, unknown>;
      toolContext: object;
      result: Record<string, unknown>;
    }): Promise<Record<string, unknown> | undefined> {
      const span = toolSpans.get(params.toolContext);
      toolSpans.delete(params.toolContext);
      try {
        if (span) {
          span.setAttribute("gen_ai.tool.call.result", truncate(toJson(params.result ?? {})));
          span.setStatus({ code: SpanStatusCode.OK });
          span.end();
        }
      } catch { /* ignore */ }
      return undefined;
    }

    async onToolErrorCallback(params: {
      tool: ToolLike;
      toolArgs: Record<string, unknown>;
      toolContext: object;
      error: Error;
    }): Promise<Record<string, unknown> | undefined> {
      const span = toolSpans.get(params.toolContext);
      toolSpans.delete(params.toolContext);
      try {
        if (span) {
          span.recordException(params.error);
          span.setStatus({ code: SpanStatusCode.ERROR, message: params.error?.message });
          span.end();
        }
      } catch { /* ignore */ }
      return undefined;
    }
  }

  const evalkitPlugin = new EvalKitAdkPlugin();
  const originalRunnerRunAsync = Runner.prototype.runAsync;

  Runner.prototype.runAsync = function (
    this: { pluginManager?: { getPlugin?: (n: string) => unknown; registerPlugin?: (p: unknown) => void } },
    ...args: unknown[]
  ) {
    try {
      if (this.pluginManager?.getPlugin && !this.pluginManager.getPlugin("evalkit")) {
        this.pluginManager.registerPlugin?.(evalkitPlugin);
      }
    } catch { /* ignore */ }
    return originalRunnerRunAsync.apply(this, args as never[]);
  };
  (Runner.prototype.runAsync as { __evalkit?: boolean }).__evalkit = true;

  const originalAgentRunAsync = BaseAgent.prototype.runAsync;

  BaseAgent.prototype.runAsync = async function* (
    this: { name?: string },
    parentContext: ParentContextLike,
    ...rest: unknown[]
  ) {
    const agentName = this?.name ?? "agent";
    const userText = textOf(parentContext?.userContent);
    const start = Date.now();
    let span: Span | undefined;
    try {
      span = client.tracer.startSpan("run_agent", {
        kind: SpanKind.INTERNAL,
        attributes: {
          "evalkit.span_type": "function_call",
          "function.args": truncate(toJson([userText])),
          "gen_ai.agent.name": agentName,
        },
      });
    } catch { /* ignore */ }

    try {
      yield* originalAgentRunAsync.call(this, parentContext, ...(rest as never[]));

      if (span) {
        try {
          const events = parentContext?.session?.events ?? [];
          const own = events.filter(
            (e) => e.timestamp !== undefined && e.timestamp >= start && e.author === agentName,
          );
          const text = own.map((e) => textOf(e.content)).join("");
          const toolCalls = own.flatMap((e) =>
            (e.content?.parts ?? [])
              .filter((p) => p.functionCall)
              .map((p) => ({ name: p.functionCall?.name, args: p.functionCall?.args })),
          );
          span.setAttribute(
            "function.result",
            truncate(toJson({ text, tool_calls: toolCalls, retrieved_context: [] })),
          );
          span.setStatus({ code: SpanStatusCode.OK });
        } catch { /* ignore */ }
        span.end();
      }
    } catch (err) {
      if (span) {
        try {
          span.recordException(err instanceof Error ? err : new Error(String(err)));
          span.setStatus({ code: SpanStatusCode.ERROR, message: err instanceof Error ? err.message : String(err) });
        } catch { /* ignore */ }
        span.end();
      }
      throw err;
    }
  };
  (BaseAgent.prototype.runAsync as { __evalkit?: boolean }).__evalkit = true;
}
