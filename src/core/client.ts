import { trace, context, ProxyTracerProvider, SpanKind, SpanStatusCode } from "@opentelemetry/api";
import type { Span, Tracer, TracerProvider, Context as OtelContext } from "@opentelemetry/api";
import type { ReadableSpan, SpanProcessor } from "@opentelemetry/sdk-trace-base";
import type { ConsoleSpanLevel, EvalKitOptions, MaskHook } from "./types.js";
import { ContextStampingProcessor, detachSpanProcessor, resolveTracing } from "./provider.js";
import type { TracingMode } from "./provider.js";
import { resolveCaptureContent, resolveCaptureSecrets } from "./redact.js";
import { resolveExportGzip } from "./exporter.js";
import { setCaptureSecrets } from "../utils/headers.js";
import { setGuardDebug, swallow } from "./guard.js";
import { FunctionIO, ioString } from "./function-io.js";
import { runBeforeFlush } from "./flush-hooks.js";
import { configureExceptions, hasRecordedError, recordError } from "./exceptions.js";
import { boundedText } from "./serialize.js";
import { cutReason, emptyStats, installDiagLogger, sdkLog } from "./diagnostics.js";
import type { EvalKitStats } from "./diagnostics.js";
import { DEFAULT_MAX_QUEUE_BYTES } from "./batch-processor.js";
import { resolveValueLimitBytes, setValueLimitBytes } from "./truncate.js";
import { configureIgnore, isIgnoredFunction } from "./ignore.js";
import { isUntracedFunction, tracingSuppressed } from "./suppress.js";
import {
  disabledByEnvironment,
  normaliseOptions,
  resolveConsoleSpanLevel,
  resolveExitHooks,
  resolveMaxQueueSize,
  resolveSampleRate,
  validateOptions,
} from "./config.js";
import {
  agentAttributes,
  agentNameOf,
  bindIdentity,
  identityAttributes,
  identityFromAttributes,
  isIdentityEmpty,
  withTaggedScope,
} from "./identity.js";
import type { Identity, Scope } from "./identity.js";

export interface StartTraceOptions extends Identity {
  attributes?: Record<string, string>;
  /** The agent this trace belongs to; every span inside it inherits the name. */
  agentName?: string;
}

const START_TRACE_OPTION_KEYS = ["userId", "sessionId", "deviceId", "agentName", "attributes"] as const;

function toStartTraceOptions(
  value?: Record<string, string> | StartTraceOptions
): StartTraceOptions {
  if (!value) return {};
  const looksLikeOptions = START_TRACE_OPTION_KEYS.some((key) => key in value);
  if (!looksLikeOptions) return { attributes: value as Record<string, string> };
  const options = value as StartTraceOptions;
  return {
    userId: options.userId,
    sessionId: options.sessionId,
    deviceId: options.deviceId,
    agentName: options.agentName,
    attributes: options.attributes,
  };
}

function definedIdentity(options: Identity): Identity {
  const out: Identity = {};
  if (options.userId) out.userId = options.userId;
  if (options.sessionId) out.sessionId = options.sessionId;
  if (options.deviceId) out.deviceId = options.deviceId;
  return out;
}

export const SDK_VERSION = "0.3.6";

/** How long flush() waits by default before it resolves false; the export itself goes on in the background. */
export const DEFAULT_FLUSH_TIMEOUT_MS = 5000;

const DEFAULT_MAX_BODY_BYTES = 64 * 1024;

function ioAttr(key: string, value: unknown, record: boolean, scrub: boolean): Record<string, string> | undefined {
  if (!record) return undefined;
  const s = ioString(value, scrub);
  return s === undefined ? undefined : { [key]: s };
}

type ResolvedOptions = Required<
  Omit<
    EvalKitOptions,
    "baseUrl" | "apiUrl" | "environment" | "appVersion" | "deviceId" | "tracerProvider" | "mask" | "maxQueueSize"
  >
> & {
  baseUrl: string;
  apiUrl: string;
  environment: string;
  appVersion: string;
  deviceId?: string;
  tracerProvider?: TracerProvider;
  mask?: MaskHook;
  maxQueueSize?: number;
  consoleSpanLevel: ConsoleSpanLevel;
};

/**
 * Resolves `promise`, or `fallback` once `ms` have passed; never rejects. The timer holds the process for
 * those `ms` at most: an app awaiting a flush on its way out waits for it, and no longer than that.
 */
export function settleWithin<T>(promise: Promise<T>, ms: number, fallback: T): Promise<T> {
  return new Promise<T>((resolve) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    if (Number.isFinite(ms)) {
      timer = setTimeout(() => resolve(fallback), Math.max(0, ms));
    }
    promise.then(
      (value) => {
        if (timer) clearTimeout(timer);
        resolve(value);
      },
      () => {
        if (timer) clearTimeout(timer);
        resolve(fallback);
      },
    );
  });
}

function definedOnly<T extends object>(value: T): Partial<T> {
  const out: Partial<T> = {};
  for (const [k, v] of Object.entries(value)) if (v !== undefined) (out as Record<string, unknown>)[k] = v;
  return out;
}

// What a client that cannot trace keeps of options that did not validate: only the plain labels.
function labelsOf(opts: unknown): Partial<EvalKitOptions> {
  if (!opts || typeof opts !== "object") return {};
  const o = opts as Record<string, unknown>;
  const out: Partial<EvalKitOptions> = {};
  for (const key of ["serviceName", "environment", "appVersion", "deviceId", "subscriptionKey"] as const) {
    if (typeof o[key] === "string") (out as Record<string, unknown>)[key] = o[key];
  }
  if (typeof o.debug === "boolean") out.debug = o.debug;
  return out;
}

let warnedInvalid = false;

class NoopProcessor implements SpanProcessor {
  onStart(): void {}
  onEnd(_span: ReadableSpan): void {}
  forceFlush(): Promise<void> {
    return Promise.resolve();
  }
  shutdown(): Promise<void> {
    return Promise.resolve();
  }
}

// Reading a returned value's tag or `then` runs a Proxy's traps, which may throw; the value then reaches
// the caller as it is.
const isGeneratorObject = (value: unknown): "sync" | "async" | undefined => {
  try {
    if (!value || typeof value !== "object") return undefined;
    const tag = Object.prototype.toString.call(value);
    if (tag === "[object Generator]") return "sync";
    if (tag === "[object AsyncGenerator]") return "async";
  } catch {
    // Not one the SDK can tell; left as it is.
  }
  return undefined;
};

const isThenable = (value: unknown): boolean => {
  try {
    return !!value && typeof (value as { then?: unknown }).then === "function";
  } catch {
    return false;
  }
};

interface EndRegistry {
  register(target: object, end: () => void, token: object): void;
  unregister(token: object): void;
}

const Registry = (globalThis as { FinalizationRegistry?: new (cleanup: (end: () => void) => void) => EndRegistry })
  .FinalizationRegistry;

const abandoned: EndRegistry | undefined = typeof Registry === "function"
  ? new Registry((end) => {
      try {
        end();
      } catch {
        // Ending an abandoned iteration's span is best effort.
      }
    })
  : undefined;

/**
 * A generator that behaves as `gen` and runs each step inside the span's context, ending the span when the
 * iteration completes, throws or is returned from (a `break` out of `for...of`). One left unfinished ends
 * its span when it is garbage collected.
 */
function traceIteration<G extends object>(
  gen: G,
  kind: "sync" | "async",
  ctx: OtelContext,
  finish: (error?: unknown) => void,
): G {
  const state = { done: false };
  const end = (error?: unknown): void => {
    if (state.done) return;
    state.done = true;
    if (abandoned) abandoned.unregister(state);
    finish(error);
  };
  const source = gen as unknown as Record<"next" | "return" | "throw", (arg?: unknown) => any>;
  const step = (method: "next" | "return" | "throw", arg: unknown): any => {
    if (state.done) return source[method](arg);
    let result: any;
    try {
      result = context.with(ctx, () => source[method](arg));
    } catch (err) {
      end(err === undefined ? new Error("generator threw undefined") : err);
      throw err;
    }
    if (kind === "async") {
      return Promise.resolve(result).then(
        (r: IteratorResult<unknown>) => {
          if (r?.done) end();
          return r;
        },
        (err: unknown) => {
          end(err === undefined ? new Error("generator rejected with undefined") : err);
          throw err;
        },
      );
    }
    if (result?.done) end();
    return result;
  };
  const wrapped = Object.create(Object.getPrototypeOf(gen));
  for (const method of ["next", "return", "throw"] as const) {
    Object.defineProperty(wrapped, method, {
      value: (arg?: unknown) => step(method, arg),
      writable: true,
      configurable: true,
    });
  }
  abandoned?.register(wrapped, () => end(), state);
  return wrapped as G;
}

export class EvalKitClient {
  readonly options: ResolvedOptions;
  readonly provider: TracerProvider;
  readonly tracingMode: TracingMode;
  private readonly processor: ContextStampingProcessor;
  readonly tracer: Tracer;
  /** Why this client traces nothing, when it does not: invalid options or EVALKIT_DISABLED / OTEL_SDK_DISABLED. */
  readonly disabledReason?: string;

  constructor(opts: EvalKitOptions) {
    const switchedOff = disabledByEnvironment();
    const problems = validateOptions(opts);
    const valid = problems.length === 0;
    const given: Partial<EvalKitOptions> = valid ? definedOnly(normaliseOptions(opts)) : labelsOf(opts);
    const resolved = {
      serviceName: "unknown",
      debug: false,
      maxExportBatchSize: 512,
      scheduledDelayMillis: 5000,
      maxBodyBytes: DEFAULT_MAX_BODY_BYTES,
      baseUrl: "https://api.syntropylabs.ai",
      apiUrl: "https://api.syntropylabs.ai",
      environment: "",
      appVersion: "",
      captureGlobalErrors: false,
      maxQueueBytes: DEFAULT_MAX_QUEUE_BYTES,
      captureConsole: true,
      inAppInclude: [],
      inAppExclude: [],
      sourceMaps: false,
      subscriptionKey: "",
      ignoreRoutes: [],
      ignoreUrls: [],
      ignoreFunctions: [],
      traceHealthChecks: false,
      ...given,
      captureContent: resolveCaptureContent(given.captureContent),
      captureSecrets: resolveCaptureSecrets(given.captureSecrets),
      exportGzip: resolveExportGzip(given.exportGzip),
      maxValueBytes: resolveValueLimitBytes(given.maxValueBytes),
      sampleRate: resolveSampleRate(given.sampleRate),
      consoleSpanLevel: resolveConsoleSpanLevel(given.consoleSpanLevel),
      exitHooks: resolveExitHooks(given.exitHooks),
      maxQueueSize: resolveMaxQueueSize(given.maxQueueSize),
    } as ResolvedOptions;
    this.options = resolved;

    if (switchedOff) {
      this.disabledReason = `${switchedOff}=true`;
    } else if (!valid) {
      this.disabledReason = `invalid options: ${problems.join("; ")}`;
      if (!warnedInvalid) {
        warnedInvalid = true;
        sdkLog("warn", `[evalkit] tracing is off: ${problems.join("; ")}. The app runs as without the SDK.`);
      }
    }

    let tracing: ReturnType<typeof resolveTracing> | undefined;
    if (!this.disabledReason) {
      try {
        setCaptureSecrets(this.options.captureSecrets);
        setGuardDebug(this.options.debug);
        setValueLimitBytes(this.options.maxValueBytes);
        installDiagLogger();
        try {
          configureIgnore(this.options);
        } catch (err) {
          swallow("compiling the ignore patterns", err);
        }
        try {
          configureExceptions({
            inAppInclude: this.options.inAppInclude,
            inAppExclude: this.options.inAppExclude,
            stackTraceLimit: this.options.stackTraceLimit,
            sourceMaps: this.options.sourceMaps,
          });
        } catch (err) {
          swallow("configuring error capture", err);
        }
        tracing = resolveTracing(
          {
            baseUrl: this.options.baseUrl,
            subscriptionKey: this.options.subscriptionKey,
            serviceName: this.options.serviceName,
            environment: this.options.environment,
            appVersion: this.options.appVersion,
            deviceId: this.options.deviceId,
            debug: this.options.debug,
            maxExportBatchSize: this.options.maxExportBatchSize,
            scheduledDelayMillis: this.options.scheduledDelayMillis,
            captureContent: this.options.captureContent,
            captureSecrets: this.options.captureSecrets,
            exportGzip: this.options.exportGzip,
            mask: this.options.mask,
            maxQueueSize: this.options.maxQueueSize,
            maxQueueBytes: this.options.maxQueueBytes,
            sampleRate: this.options.sampleRate,
          },
          this.options.tracerProvider
        );
      } catch (err) {
        // Setting tracing up never fails the app's start; the SDK stays off instead.
        this.disabledReason = `tracing could not start: ${cutReason(err)}`;
        sdkLog("warn", `[evalkit] ${this.disabledReason}. The app runs as without the SDK.`);
      }
    }

    if (!tracing) {
      this.provider = new ProxyTracerProvider();
      this.processor = new ContextStampingProcessor(new NoopProcessor());
      this.tracingMode = "disabled";
    } else {
      this.provider = tracing.provider;
      this.processor = tracing.processor;
      this.tracingMode = tracing.mode;
    }
    this.tracer = this.provider.getTracer("evalkit", SDK_VERSION);
  }

  /** Whether this client traces at all. */
  get enabled(): boolean {
    return this.tracingMode !== "disabled";
  }

  /** The span pipeline's counters: what is queued, what was dropped and why, and the circuit's state. */
  getStats(): EvalKitStats {
    if (!this.enabled) return emptyStats("disabled");
    try {
      return this.processor.stats() ?? emptyStats();
    } catch {
      return emptyStats();
    }
  }

  private metaAttributes(): Record<string, string> {
    const meta: Record<string, string> = {
      "evalkit.sdk_version": SDK_VERSION,
    };
    if (this.options.environment) meta["evalkit.environment"] = this.options.environment;
    if (this.options.appVersion) meta["evalkit.app_version"] = this.options.appVersion;
    if (this.options.deviceId) meta["evalkit.device_id"] = this.options.deviceId;
    return meta;
  }

  startTrace(name: string, attributesOrOptions?: Record<string, string> | StartTraceOptions): {
    traceId: string;
    end: (status?: "OK" | "ERROR") => void;
    ctx: OtelContext;
  } {
    const options = toStartTraceOptions(attributesOrOptions);
    // Explicit option > attribute (any spelling), field by field; the result is bound to the
    // trace so every child span, including auto-instrumented ones, carries it.
    const identity: Identity = { ...identityFromAttributes(options.attributes), ...definedIdentity(options) };
    const agentName = options.agentName || agentNameOf(options.attributes);
    const span = this.tracer.startSpan(
      name,
      {
        kind: SpanKind.SERVER,
        attributes: {
          "evalkit.span_type": "log",
          ...this.metaAttributes(),
          ...options.attributes,
          ...identityAttributes(identity),
          ...agentAttributes(agentName),
        },
      },
      context.active()
    );

    const ctx = trace.setSpan(context.active(), span);
    const traceId = span.spanContext().traceId;
    const bound: Scope = agentName ? { ...identity, agentName } : identity;
    if (!isIdentityEmpty(identity) || agentName) bindIdentity(traceId, bound);

    return {
      traceId,
      ctx,
      end: (status: "OK" | "ERROR" = "OK") => {
        span.setStatus({ code: status === "OK" ? SpanStatusCode.OK : SpanStatusCode.ERROR });
        span.end();
      },
    };
  }

  /** A value as recorded text within the body limit; nothing when bodies are not recorded (limit 0). */
  private bodyText(value: unknown): string | undefined {
    const limit = this.options.maxBodyBytes;
    if (!(limit > 0)) return undefined;
    return boundedText(value, limit);
  }

  startHttpTrace(
    name: string,
    httpCtx: {
      method: string;
      url: string;
      headers?: Record<string, string>;
      requestBody?: unknown;
    },
    attributes?: Record<string, string>
  ): {
    traceId: string;
    end: (status?: "OK" | "ERROR", response?: HttpTraceResponse) => void;
    ctx: OtelContext;
  } {
    // A body or header object that JSON cannot express (a BigInt, a cycle, a getter that throws) is recorded
    // as far as it can be, and never fails the request it belongs to.
    const headers = httpCtx.headers ? boundedText(httpCtx.headers, Math.max(this.options.maxBodyBytes, 16 * 1024)) : undefined;
    const requestBody = httpCtx.requestBody !== undefined ? this.bodyText(httpCtx.requestBody) : undefined;
    const span = this.tracer.startSpan(
      name,
      {
        kind: SpanKind.SERVER,
        attributes: {
          "evalkit.span_type": "http_call",
          "http.method": httpCtx.method,
          "http.url": httpCtx.url,
          ...(headers !== undefined ? { "http.request.headers": headers } : {}),
          ...(requestBody !== undefined ? { "http.request.body": requestBody } : {}),
          ...this.metaAttributes(),
          ...attributes,
        },
      },
      context.active()
    );

    const ctx = trace.setSpan(context.active(), span);
    const traceId = span.spanContext().traceId;

    return {
      traceId,
      ctx,
      end: (status: "OK" | "ERROR" = "OK", response?: HttpTraceResponse) => {
        try {
          // The route template (`/orders/:id`) names the span once the framework has matched it; the
          // raw path would make every id an operation of its own.
          if (response?.route) {
            span.updateName(`${httpCtx.method} ${response.route}`);
            span.setAttribute("http.route", response.route);
          }
          if (response?.statusCode !== undefined) span.setAttribute("http.status_code", response.statusCode);
          if (response?.body !== undefined && span.isRecording()) {
            const body = this.bodyText(response.body);
            if (body !== undefined) span.setAttribute("http.response.body", body);
          }
          if (response?.headers && span.isRecording()) {
            const text = boundedText(response.headers, Math.max(this.options.maxBodyBytes, 16 * 1024));
            if (text !== undefined) span.setAttribute("http.response.headers", text);
          }
          if (response?.error !== undefined) recordError(span, response.error, { escaped: response.errorEscaped === true });
          if (!hasRecordedError(span)) span.setStatus({ code: status === "OK" ? SpanStatusCode.OK : SpanStatusCode.ERROR });
        } catch (err) {
          swallow("ending a request span", err);
        }
        try {
          span.end();
        } catch (err) {
          swallow("ending a request span", err);
        }
      },
    };
  }

  startSpan(
    name: string,
    attributes?: Record<string, string | number | boolean>,
    parentCtx?: OtelContext
  ): { end: (status?: "OK" | "ERROR", extraAttributes?: Record<string, string | number | boolean>) => void; ctx: OtelContext } {
    const span = this.tracer.startSpan(
      name,
      {
        kind: SpanKind.INTERNAL,
        attributes: {
          "evalkit.span_type": "function_call",
          ...this.metaAttributes(),
          ...attributes,
        },
      },
      parentCtx ?? context.active()
    );
    const ctx = trace.setSpan(withTaggedScope(context.active(), attributes), span);
    return {
      ctx,
      end: (status: "OK" | "ERROR" = "OK", extraAttributes?: Record<string, string | number | boolean>) => {
        if (extraAttributes) span.setAttributes(extraAttributes);
        // An error recorded on the span keeps the status it set, with the error's description.
        if (!hasRecordedError(span)) span.setStatus({ code: status === "OK" ? SpanStatusCode.OK : SpanStatusCode.ERROR });
        span.end();
      },
    };
  }

  traceFunction<T extends (...args: any[]) => any>(
    name: string,
    fn: T,
    attributes?: Record<string, string | number | boolean>,
    captureIO: boolean = true,
  ): T {
    return this.traced("function", name, fn, attributes, captureIO);
  }

  traceTool<T extends (...args: any[]) => any>(
    name: string,
    fn: T,
    attributes?: Record<string, string | number | boolean>,
    captureIO: boolean = true,
  ): T {
    return this.traced("tool", name, fn, attributes, captureIO);
  }

  /**
   * `fn` inside a span of its own: a function call or a tool call. The span covers a returned promise until
   * it settles and a returned generator until its iteration ends. Whatever the tracing does, `fn` runs and
   * its result or error reaches the caller unchanged.
   */
  private traced<T extends (...args: any[]) => any>(
    kind: "function" | "tool",
    name: string,
    fn: T,
    attributes: Record<string, string | number | boolean> | undefined,
    captureIO: boolean,
  ): T {
    // A function the app keeps out of traces, by name or with untraced(), stays as it is: the ignore wins
    // over an explicit wrapper.
    try {
      if (isUntracedFunction(fn) || isIgnoredFunction(name)) return fn;
    } catch {
      // Traced as asked.
    }
    const self = this;
    const io = captureIO ? new FunctionIO(fn, name) : undefined;
    const resultKey = kind === "tool" ? "tool.result" : "function.result";
    return function (this: any, ...args: any[]) {
      if (tracingSuppressed()) return fn.apply(this, args);
      let ctx: OtelContext;
      let span: Span | undefined;
      let end: (status?: "OK" | "ERROR", extra?: Record<string, string | number | boolean>) => void;
      let record = false;
      let scrub = true;
      try {
        scrub = !self.options.captureSecrets;
        record = !!io && (!scrub || !io.secretFunction);
        let startAttrs: Record<string, string | number | boolean>;
        if (kind === "tool") {
          const recorded = record && scrub ? io!.arguments(args) : args;
          startAttrs = {
            "evalkit.span_type": "tool_call",
            "tool.name": name,
            "gen_ai.tool.name": name,
            ...attributes,
            ...(record && args.length ? ioAttr("tool.arguments", recorded.length === 1 ? recorded[0] : recorded, record, scrub) : undefined),
          };
        } else {
          startAttrs = {
            "evalkit.span_type": "function_call",
            ...attributes,
            ...(record && args.length ? ioAttr("function.args", scrub ? io!.arguments(args) : args, record, scrub) : undefined),
          };
        }
        const s = self.startSpan(name, startAttrs);
        ctx = s.ctx;
        end = s.end;
        span = trace.getSpan(ctx);
      } catch {
        return fn.apply(this, args);
      }

      const safeEnd = (status: "OK" | "ERROR", extra?: Record<string, string | number | boolean>) => {
        try { end(status, extra); } catch {  }
      };
      const failed = (err: unknown) => {
        recordError(span, err, { escaped: true });
        safeEnd("ERROR");
      };
      const succeeded = (value: unknown) => {
        let extra: Record<string, string> | undefined;
        try { extra = ioAttr(resultKey, value, record, scrub); } catch {  }
        safeEnd("OK", extra);
      };

      let result: any;
      try {
        result = context.with(ctx, () => fn.apply(this, args));
      } catch (err: any) {
        failed(err);
        throw err;
      }

      const iteration = isGeneratorObject(result);
      if (iteration) {
        try {
          return traceIteration(result, iteration, ctx, (err) => (err === undefined ? safeEnd("OK") : failed(err)));
        } catch {
          safeEnd("OK");
          return result;
        }
      }

      if (isThenable(result)) {
        return result.then(
          (v: any) => { succeeded(v); return v; },
          (e: any) => { failed(e); throw e; },
        ) as any;
      }

      succeeded(result);
      return result;
    } as T;
  }

  /**
   * Sends every span ended so far. It resolves whether or not the receiver took them, since the app awaits it
   * on its way out and a tracing failure must not fail the app: true when the export succeeded, false when it
   * did not or took longer than `timeoutMs` (default 5000; the export then goes on in the background). The
   * reason is logged with `debug: true`.
   */
  async flush(timeoutMs: number = DEFAULT_FLUSH_TIMEOUT_MS): Promise<boolean> {
    if (!this.enabled) return false;
    try {
      runBeforeFlush();
      const wait = typeof timeoutMs === "number" && !Number.isNaN(timeoutMs) ? timeoutMs : DEFAULT_FLUSH_TIMEOUT_MS;
      return await settleWithin(this.processor.flushAll(), wait, false);
    } catch (err) {
      swallow("flushing spans", err);
      return false;
    }
  }

  /**
   * flush() for a process on its way out: an export still running when `timeoutMs` is up is abandoned, so a
   * receiver that does not answer never holds the exit up.
   */
  async flushForExit(timeoutMs: number): Promise<boolean> {
    // A receiver the export in flight already failed to reach is not waited for on the way out.
    if (this.enabled && this.processor.exportFailing()) {
      this.processor.abortExport();
      return false;
    }
    const ok = await this.flush(timeoutMs);
    if (!ok) {
      try {
        this.processor.abortExport();
      } catch {
        // Nothing left to abandon.
      }
    }
    return ok;
  }

  /**
   * Stops this client's exporting: its processor leaves the provider and flushes what it holds, for at most
   * `timeoutMs`. The provider itself stays, the app's own or the one the SDK registered for the process,
   * which a later init() reuses.
   */
  async destroy(timeoutMs: number = DEFAULT_FLUSH_TIMEOUT_MS): Promise<void> {
    if (!this.enabled) return;
    detachSpanProcessor(this.provider, this.processor);
    try {
      await settleWithin(this.processor.shutdown().then(() => true), timeoutMs, false);
    } catch (err) {
      swallow("shutting down the exporter", err);
    }
  }
}

export interface HttpTraceResponse {
  statusCode?: number;
  body?: unknown;
  headers?: Record<string, string>;
  route?: string;
  /** The error the request failed with; recorded on the span by the exception contract. */
  error?: unknown;
  /** Whether the error propagated out of the request handling (rethrown) rather than becoming a response. */
  errorEscaped?: boolean;
}
