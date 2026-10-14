import { trace, context, SpanKind, SpanStatusCode } from "@opentelemetry/api";
import type { Tracer, TracerProvider, Context as OtelContext } from "@opentelemetry/api";
import type { SpanProcessor } from "@opentelemetry/sdk-trace-base";
import type { EvalKitOptions, MaskHook } from "./types.js";
import { detachSpanProcessor, resolveTracing } from "./provider.js";
import type { TracingMode } from "./provider.js";
import { errorAttrs } from "./errors-util.js";
import { resolveCaptureContent, resolveCaptureSecrets } from "./redact.js";
import { resolveExportGzip } from "./exporter.js";
import { setCaptureSecrets } from "../utils/headers.js";
import { setGuardDebug, swallow } from "./guard.js";
import { FunctionIO, ioString } from "./function-io.js";
import { runBeforeFlush } from "./flush-hooks.js";
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

const SDK_VERSION = "0.3.5";

function ioAttr(key: string, value: unknown, record: boolean, scrub: boolean): Record<string, string> | undefined {
  if (!record) return undefined;
  const s = ioString(value, scrub);
  return s === undefined ? undefined : { [key]: s };
}

type ResolvedOptions = Required<
  Omit<EvalKitOptions, "baseUrl" | "apiUrl" | "environment" | "appVersion" | "deviceId" | "tracerProvider" | "mask">
> & {
  baseUrl: string;
  apiUrl: string;
  environment: string;
  appVersion: string;
  deviceId?: string;
  tracerProvider?: TracerProvider;
  mask?: MaskHook;
};

export class EvalKitClient {
  readonly options: ResolvedOptions;
  readonly provider: TracerProvider;
  readonly tracingMode: TracingMode;
  private readonly processor: SpanProcessor;
  readonly tracer: Tracer;

  constructor(opts: EvalKitOptions) {
    this.options = {
      serviceName: "unknown",
      debug: false,
      maxExportBatchSize: 512,
      scheduledDelayMillis: 5000,
      maxBodyBytes: 10 * 1024 * 1024,
      baseUrl: "https://api.syntropylabs.ai",
      apiUrl: "https://api.syntropylabs.ai",
      environment: "",
      appVersion: "",
      captureGlobalErrors: false,
      ...opts,
      captureContent: resolveCaptureContent(opts.captureContent),
      captureSecrets: resolveCaptureSecrets(opts.captureSecrets),
      exportGzip: resolveExportGzip(opts.exportGzip),
    };

    setCaptureSecrets(this.options.captureSecrets);
    setGuardDebug(this.options.debug);

    const tracing = resolveTracing(
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
      },
      this.options.tracerProvider
    );

    this.provider = tracing.provider;
    this.processor = tracing.processor;
    this.tracingMode = tracing.mode;
    this.tracer = this.provider.getTracer("evalkit", SDK_VERSION);
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
    end: (status?: "OK" | "ERROR", response?: { statusCode?: number; body?: unknown; headers?: Record<string, string>; route?: string }) => void;
    ctx: OtelContext;
  } {
    const span = this.tracer.startSpan(
      name,
      {
        kind: SpanKind.SERVER,
        attributes: {
          "evalkit.span_type": "http_call",
          "http.method": httpCtx.method,
          "http.url": httpCtx.url,
          ...(httpCtx.headers ? { "http.request.headers": JSON.stringify(httpCtx.headers) } : {}),
          ...(httpCtx.requestBody !== undefined ? { "http.request.body": JSON.stringify(httpCtx.requestBody) } : {}),
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
      end: (status: "OK" | "ERROR" = "OK", response?: { statusCode?: number; body?: unknown; headers?: Record<string, string>; route?: string }) => {
        // The route template (`/orders/:id`) names the span once the framework has matched it; the
        // raw path would make every id an operation of its own.
        if (response?.route) {
          span.updateName(`${httpCtx.method} ${response.route}`);
          span.setAttribute("http.route", response.route);
        }
        if (response?.statusCode !== undefined) span.setAttribute("http.status_code", response.statusCode);
        if (response?.body !== undefined) span.setAttribute("http.response.body", JSON.stringify(response.body));
        if (response?.headers) span.setAttribute("http.response.headers", JSON.stringify(response.headers));
        span.setStatus({ code: status === "OK" ? SpanStatusCode.OK : SpanStatusCode.ERROR });
        span.end();
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
        span.setStatus({ code: status === "OK" ? SpanStatusCode.OK : SpanStatusCode.ERROR });
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
    const self = this;
    const io = captureIO ? new FunctionIO(fn, name) : undefined;
    return function (this: any, ...args: any[]) {

      let ctx: OtelContext;
      let end: (status?: 'OK' | 'ERROR', extra?: Record<string, string | number | boolean>) => void;
      let record = false;
      let scrub = true;
      try {
        scrub = !self.options.captureSecrets;
        record = !!io && (!scrub || !io.secretFunction);
        const startAttrs: Record<string, string | number | boolean> = {
          'evalkit.span_type': 'function_call',
          ...attributes,
          ...(record && args.length ? ioAttr('function.args', scrub ? io!.arguments(args) : args, record, scrub) : undefined),
        };
        const s = self.startSpan(name, startAttrs);
        ctx = s.ctx; end = s.end;
      } catch {
        return fn.apply(this, args);
      }

      const safeEnd = (status: 'OK' | 'ERROR', extra?: Record<string, string | number | boolean>) => {
        try { end(status, extra); } catch {  }
      };

      let result: any;
      try {
        result = context.with(ctx, () => fn.apply(this, args));
      } catch (err: any) {
        const error = err instanceof Error ? err : new Error(String(err));
        try { trace.getSpan(ctx)?.recordException(error); } catch {  }
        safeEnd('ERROR', errorAttrs(error));
        throw err;
      }

      if (result && typeof result.then === 'function') {
        return result.then(
          (v: any) => { safeEnd('OK', ioAttr('function.result', v, record, scrub)); return v; },
          (e: any) => {
            const error = e instanceof Error ? e : new Error(String(e));
            try { trace.getSpan(ctx)?.recordException(error); } catch {  }
            safeEnd('ERROR', errorAttrs(error));
            throw e;
          },
        ) as any;
      }

      safeEnd('OK', ioAttr('function.result', result, record, scrub));
      return result;
    } as T;
  }

  traceTool<T extends (...args: any[]) => any>(
    name: string,
    fn: T,
    attributes?: Record<string, string | number | boolean>,
    captureIO: boolean = true,
  ): T {
    const self = this;
    const io = captureIO ? new FunctionIO(fn, name) : undefined;
    return function (this: any, ...args: any[]) {
      let ctx: OtelContext;
      let end: (status?: 'OK' | 'ERROR', extra?: Record<string, string | number | boolean>) => void;
      let record = false;
      let scrub = true;
      try {
        scrub = !self.options.captureSecrets;
        record = !!io && (!scrub || !io.secretFunction);
        const recorded = record && scrub ? io!.arguments(args) : args;
        const startAttrs: Record<string, string | number | boolean> = {
          'evalkit.span_type': 'tool_call',
          'tool.name': name,
          'gen_ai.tool.name': name,
          ...attributes,
          ...(record && args.length ? ioAttr('tool.arguments', recorded.length === 1 ? recorded[0] : recorded, record, scrub) : undefined),
        };
        const s = self.startSpan(name, startAttrs);
        ctx = s.ctx; end = s.end;
      } catch {
        return fn.apply(this, args);
      }

      const safeEnd = (status: 'OK' | 'ERROR', extra?: Record<string, string | number | boolean>) => {
        try { end(status, extra); } catch {  }
      };

      let result: any;
      try {
        result = context.with(ctx, () => fn.apply(this, args));
      } catch (err: any) {
        const error = err instanceof Error ? err : new Error(String(err));
        try { trace.getSpan(ctx)?.recordException(error); } catch {  }
        safeEnd('ERROR', errorAttrs(error));
        throw err;
      }

      if (result && typeof result.then === 'function') {
        return result.then(
          (v: any) => { safeEnd('OK', ioAttr('tool.result', v, record, scrub)); return v; },
          (e: any) => {
            const error = e instanceof Error ? e : new Error(String(e));
            try { trace.getSpan(ctx)?.recordException(error); } catch {  }
            safeEnd('ERROR', errorAttrs(error));
            throw e;
          },
        ) as any;
      }

      safeEnd('OK', ioAttr('tool.result', result, record, scrub));
      return result;
    } as T;
  }

  /**
   * Sends every span ended so far. It resolves whether or not the receiver took them, since the app awaits it
   * on its way out and a tracing failure must not fail the app: true when the export succeeded, false when it
   * did not (the reason is logged with `debug: true`).
   */
  async flush(): Promise<boolean> {
    try {
      runBeforeFlush();
      await this.processor.forceFlush();
      return true;
    } catch (err) {
      swallow("flushing spans", err);
      return false;
    }
  }

  /**
   * Stops this client's exporting: its processor leaves the provider and flushes what it holds. The provider
   * itself stays, the app's own or the one the SDK registered for the process, which a later init() reuses.
   */
  async destroy(): Promise<void> {
    detachSpanProcessor(this.provider, this.processor);
    try {
      await this.processor.shutdown();
    } catch (err) {
      swallow("shutting down the exporter", err);
    }
  }
}
