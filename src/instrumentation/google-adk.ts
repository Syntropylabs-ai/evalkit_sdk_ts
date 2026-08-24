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
      } catch {  }
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
      } catch {  }
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
      } catch {  }
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
    } catch {  }
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
    } catch {  }

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
        } catch {  }
        span.end();
      }
    } catch (err) {
      if (span) {
        try {
          span.recordException(err instanceof Error ? err : new Error(String(err)));
          span.setStatus({ code: SpanStatusCode.ERROR, message: err instanceof Error ? err.message : String(err) });
        } catch {  }
        span.end();
      }
      throw err;
    }
  };
  (BaseAgent.prototype.runAsync as { __evalkit?: boolean }).__evalkit = true;
}
