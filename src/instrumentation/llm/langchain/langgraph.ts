import { SpanKind, context as otelContext, trace } from "@opentelemetry/api";
import type { Span } from "@opentelemetry/api";
import type { EvalKitClient } from "../../../core/client.js";
import { guarded, swallow } from "../../../core/guard.js";
import { claimPatch } from "../../_patched.js";
import { observeCall } from "../_api-promise.js";
import { observeStream } from "../_stream.js";
import { endSpan } from "../_span.js";

// A LangGraph graph run outside any span (a script, a worker, a test) gets a root span of its own, so its
// nodes, model calls and tool calls share one trace. Its callbacks report the nodes, but nothing the
// callbacks see puts the provider calls made inside them in the same trace.

// Root spans opened here, until the graph's own run takes one as its record.
const graphRoots = new WeakSet<Span>();

/** Whether `span` is a graph root this module opened that no run has taken yet; it is taken if so. */
export function takeGraphRoot(span: Span): boolean {
  if (!graphRoots.has(span)) return false;
  graphRoots.delete(span);
  return true;
}

function startRoot(client: EvalKitClient, graph: { name?: unknown }): { span: Span; ctx: ReturnType<typeof otelContext.active> } {
  const name = typeof graph?.name === "string" && graph.name ? graph.name : "LangGraph";
  const span = client.tracer.startSpan(name, {
    kind: SpanKind.INTERNAL,
    attributes: { "evalkit.span_type": "function_call", "evalkit.framework": "langgraph" },
  }, otelContext.active());
  graphRoots.add(span);
  return { span, ctx: trace.setSpan(otelContext.active(), span) };
}

function inSpan(): boolean {
  return !!trace.getActiveSpan()?.isRecording();
}

/** Patches Pregel, the class every compiled LangGraph graph is, so `invoke` and `stream` open a root span. */
export function patchLangGraph(client: EvalKitClient, Pregel: any): void {
  const proto = Pregel?.prototype;
  if (!proto) return;

  const invoke = proto.invoke;
  if (typeof invoke === "function" && claimPatch(proto, "invoke")) {
    proto.invoke = function (this: any, ...args: unknown[]): unknown {
      if (inSpan()) return invoke.apply(this, args);
      const root = guarded("starting a LangGraph root span", () => startRoot(client, this), undefined);
      if (!root) return invoke.apply(this, args);
      return observeCall(
        () => otelContext.with(root.ctx, () => invoke.apply(this, args)),
        (result) => { endSpan(root.span); return result; },
        (err) => endSpan(root.span, err),
      );
    };
  }

  // stream() runs the graph as the app reads the stream, so each read runs inside the root span.
  const stream = proto.stream;
  if (typeof stream === "function" && claimPatch(proto, "stream")) {
    proto.stream = function (this: any, ...args: unknown[]): unknown {
      if (inSpan()) return stream.apply(this, args);
      const root = guarded("starting a LangGraph root span", () => startRoot(client, this), undefined);
      if (!root) return stream.apply(this, args);
      return observeCall(
        () => otelContext.with(root.ctx, () => stream.apply(this, args)),
        (result) => observeStream(result, () => {}, (error) => endSpan(root.span, error), root.ctx),
        (err) => endSpan(root.span, err),
      );
    };
  }
}

export function patchLangGraphModule(client: EvalKitClient, mod: any): boolean {
  try {
    const Pregel = mod?.Pregel ?? mod?.default?.Pregel;
    if (!Pregel?.prototype) return false;
    patchLangGraph(client, Pregel);
    return true;
  } catch (err) {
    swallow("patching LangGraph", err);
    return false;
  }
}
