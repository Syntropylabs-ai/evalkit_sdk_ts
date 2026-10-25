/**
 * Work that is left out of tracing as a whole: an ignored route, a health probe, or code the app ran through
 * `untraced` / `withoutTracing`. It runs in an OpenTelemetry context with tracing suppressed, so every tracer
 * hands out non-recording spans inside it, and the SDK's own hooks (outgoing calls, console capture, function
 * spans, framework adapters) check the same flag before they record or propagate anything. The context is
 * carried by AsyncLocalStorage, so it follows the work's own awaits, timers and callbacks and never reaches a
 * concurrent request.
 */
import { context as otelContext } from "@opentelemetry/api";
import type { Context as OtelContext } from "@opentelemetry/api";
import { isTracingSuppressed, suppressTracing } from "@opentelemetry/core";
import { BoundedMap } from "../utils/bounded-map.js";
import { serverSpanOf } from "../utils/http-route.js";

/** Whether the code running now is inside an untraced scope. */
export function tracingSuppressed(): boolean {
  try {
    return isTracingSuppressed(otelContext.active());
  } catch {
    return false;
  }
}

/** `ctx` (by default the active context) with tracing suppressed. */
export function suppressedContext(ctx?: OtelContext): OtelContext {
  return suppressTracing(ctx ?? otelContext.active());
}

/** Runs `fn` with `this` and `args` inside an untraced scope; as it is when the scope cannot be made. */
export function runUntraced<T>(fn: (...args: any[]) => T, thisArg?: unknown, args: unknown[] = []): T {
  let ctx: OtelContext;
  try {
    ctx = suppressedContext();
  } catch {
    return fn.apply(thisArg, args);
  }
  return otelContext.with(ctx, fn, thisArg, ...args);
}

/**
 * Runs `fn` with nothing traced inside it: no spans from auto-instrumented model calls, outgoing HTTP calls,
 * function spans or console capture, and no traceparent on the calls it makes. Work it starts (a timer, a
 * promise it does not await) stays untraced. Returns what `fn` returns; works before init() too.
 */
export function withoutTracing<T>(fn: () => T): T {
  return runUntraced(fn);
}

const UNTRACED = "__evalkitUntraced";

/** Whether `fn` is a wrapper `untraced()` made: function tracing leaves it as it is. */
export function isUntracedFunction(fn: unknown): boolean {
  try {
    return typeof fn === "function" && (fn as unknown as Record<string, unknown>)[UNTRACED] === true;
  } catch {
    return false;
  }
}

function generatorKind(value: unknown): "sync" | "async" | undefined {
  try {
    if (!value || typeof value !== "object") return undefined;
    const tag = Object.prototype.toString.call(value);
    if (tag === "[object Generator]") return "sync";
    if (tag === "[object AsyncGenerator]") return "async";
  } catch {
    // Not one the SDK can tell; left as it is.
  }
  return undefined;
}

/**
 * A generator that behaves as `gen` with each step run inside `ctx`: a generator's body runs as it is
 * iterated, after the call that made it returned, so the scope has to be entered for every step.
 */
function stepsInContext<G extends object>(gen: G, kind: "sync" | "async", ctx: OtelContext): G {
  const source = gen as unknown as Record<"next" | "return" | "throw", (arg?: unknown) => unknown>;
  const wrapped = Object.create(Object.getPrototypeOf(gen));
  for (const method of ["next", "return", "throw"] as const) {
    Object.defineProperty(wrapped, method, {
      value: (arg?: unknown) => otelContext.with(ctx, () => source[method](arg)),
      writable: true,
      configurable: true,
    });
  }
  if (kind === "async") {
    Object.defineProperty(wrapped, Symbol.asyncIterator, { value: () => wrapped, writable: true, configurable: true });
  } else {
    Object.defineProperty(wrapped, Symbol.iterator, { value: () => wrapped, writable: true, configurable: true });
  }
  return wrapped as G;
}

/**
 * `fn` with nothing traced inside it, each time it is called: `this`, the arguments, the result and the error
 * are its own. A generator it returns has every step run untraced as well. Function tracing (traceFunction,
 * @Traced, auto-tracing) leaves the wrapper as it is.
 */
export function untraced<T extends (...args: any[]) => any>(fn: T): T {
  if (typeof fn !== "function" || isUntracedFunction(fn)) return fn;
  const wrapper = function (this: unknown, ...args: unknown[]) {
    let ctx: OtelContext;
    try {
      ctx = suppressedContext();
    } catch {
      return fn.apply(this, args);
    }
    const result: unknown = otelContext.with(ctx, fn as (...a: unknown[]) => unknown, this, ...args);
    const kind = generatorKind(result);
    if (!kind) return result;
    try {
      return stepsInContext(result as object, kind, ctx);
    } catch {
      return result;
    }
  };
  try { Object.defineProperty(wrapper, "name", { value: fn.name, configurable: true }); } catch {  }
  try { Object.defineProperty(wrapper, "length", { value: fn.length, configurable: true }); } catch {  }
  try { Object.defineProperty(wrapper, UNTRACED, { value: true }); } catch {  }
  return wrapper as unknown as T;
}

// ── spans already open when their request turned out to be ignored ───────────────────────────────────────

const droppedSpans = new WeakSet<object>();
// By id as well: a span started under a dropped one names only its parent's id.
const droppedIds = new BoundedMap<string, true>(10_000, 10 * 60_000);

function spanIdOf(span: unknown): string | undefined {
  try {
    return (span as { spanContext?: () => { spanId?: string } }).spanContext?.()?.spanId;
  } catch {
    return undefined;
  }
}

function parentIdOf(span: unknown): string | undefined {
  const s = span as { parentSpanContext?: { spanId?: string }; parentSpanId?: string };
  return s.parentSpanContext?.spanId ?? s.parentSpanId;
}

/**
 * Leaves `span` out of the export, with every span started under it. For a server span the http server
 * opened before a framework adapter could tell its request is ignored (a route matched by template only).
 */
export function dropSpan(span: unknown): void {
  if (!span || typeof span !== "object") return;
  try {
    droppedSpans.add(span);
    const id = spanIdOf(span);
    if (id) droppedIds.set(id, true);
  } catch {
    // The span is then exported as recorded.
  }
}

/** Whether a span that is ending was dropped, or started under one that was; such a span is not exported. */
export function takeDropped(span: unknown): boolean {
  if (!span || typeof span !== "object") return false;
  if (droppedSpans.has(span)) {
    droppedSpans.delete(span);
    return true;
  }
  if (droppedIds.size === 0) return false;
  const parent = parentIdOf(span);
  if (parent === undefined || !droppedIds.has(parent)) return false;
  const id = spanIdOf(span);
  if (id) droppedIds.set(id, true);
  return true;
}

/** Whether a span that is starting belongs to a dropped one; it is then dropped too. */
export function startsUnderDropped(span: unknown): boolean {
  if (droppedIds.size === 0) return false;
  const parent = parentIdOf(span);
  return parent !== undefined && droppedIds.has(parent);
}

/**
 * The context the rest of an ignored request runs in, untraced. A server span the http server already opened
 * for the Node request `nodeReq` (before the adapter could tell the request is ignored) is not exported, and
 * neither is any span started under it.
 */
export function untracedRequest(nodeReq: unknown): OtelContext {
  try {
    const core = serverSpanOf(nodeReq);
    if (core) dropSpan(core.span);
  } catch {
    // Nothing open for the request.
  }
  return suppressedContext();
}
