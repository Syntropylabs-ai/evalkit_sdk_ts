import { trace, context, SpanKind, SpanStatusCode } from "@opentelemetry/api";
import type { Tracer, Context as OtelContext } from "@opentelemetry/api";
import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node";
import { BatchSpanProcessor } from "@opentelemetry/sdk-trace-base";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { ATTR_SERVICE_NAME } from "@opentelemetry/semantic-conventions";
import type { EvalKitOptions } from "./types.js";
import { EvalKitExporter } from "./exporter.js";
import { errorAttrs } from "./errors-util.js";

const SDK_VERSION = "0.2.0";

const IO_MAX = 4096;

/** Serialize a function arg / return value for a span attribute. Never throws.
 *  Returns undefined for `undefined` (so the caller omits the attribute instead of
 *  storing the literal string "undefined"). */
function safeIO(value: unknown, limit: number = IO_MAX): string | undefined {
  if (value === undefined) return undefined;
  let s: string | undefined;
  try {
    s = JSON.stringify(value);
  } catch {
    /* fall through */
  }
  if (s === undefined) {
    try {
      s = String(value);
    } catch {
      s = "<unserializable>";
    }
  }
  return s.length > limit ? s.slice(0, limit) + "…" : s;
}

/** Build a single capture attribute, omitted entirely when value is undefined/unserializable. */
function ioAttr(key: string, value: unknown, captureIO: boolean): Record<string, string> | undefined {
  if (!captureIO) return undefined;
  const s = safeIO(value);
  return s === undefined ? undefined : { [key]: s };
}

type ResolvedOptions = Required<Omit<EvalKitOptions, "baseUrl" | "apiUrl" | "environment" | "appVersion" | "deviceId">> & {
  baseUrl: string;
  apiUrl: string;
  environment: string;
  appVersion: string;
  deviceId?: string;
};

export class EvalKitClient {
  readonly options: ResolvedOptions;
  private provider: NodeTracerProvider;
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
    };

    const exporter = new EvalKitExporter({
      baseUrl: this.options.baseUrl,
      subscriptionKey: this.options.subscriptionKey,
      debug: this.options.debug,
    });

    this.provider = new NodeTracerProvider({
      resource: resourceFromAttributes({
        [ATTR_SERVICE_NAME]: this.options.serviceName,
      }),
      spanProcessors: [
        new BatchSpanProcessor(exporter, {
          maxExportBatchSize: this.options.maxExportBatchSize,
          scheduledDelayMillis: this.options.scheduledDelayMillis,
        }),
      ],
    });

    this.provider.register();
    this.tracer = trace.getTracer("evalkit", "0.1.0");
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

  startTrace(name: string, attributes?: Record<string, string>): {
    traceId: string;
    end: (status?: "OK" | "ERROR") => void;
    ctx: OtelContext;
  } {
    const span = this.tracer.startSpan(
      name,
      {
        kind: SpanKind.SERVER,
        attributes: {
          "evalkit.span_type": "log",
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
    end: (status?: "OK" | "ERROR", response?: { statusCode?: number; body?: unknown; headers?: Record<string, string> }) => void;
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
      end: (status: "OK" | "ERROR" = "OK", response?: { statusCode?: number; body?: unknown; headers?: Record<string, string> }) => {
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
    const ctx = trace.setSpan(context.active(), span);
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
    return function (this: any, ...args: any[]) {
      // Tracing must NEVER prevent the host function from running. If span setup
      // throws for any reason, fall back to calling the original untraced.
      let ctx: OtelContext;
      let end: (status?: 'OK' | 'ERROR', extra?: Record<string, string | number | boolean>) => void;
      try {
        const startAttrs: Record<string, string | number | boolean> = {
          'evalkit.span_type': 'function_call',
          ...attributes,
          ...(captureIO && args.length ? ioAttr('function.args', args, captureIO) : undefined),
        };
        const s = self.startSpan(name, startAttrs);
        ctx = s.ctx; end = s.end;
      } catch {
        return fn.apply(this, args);
      }

      const safeEnd = (status: 'OK' | 'ERROR', extra?: Record<string, string | number | boolean>) => {
        try { end(status, extra); } catch { /* never throw from tracing */ }
      };

      let result: any;
      try {
        result = context.with(ctx, () => fn.apply(this, args));
      } catch (err: any) {
        const error = err instanceof Error ? err : new Error(String(err));
        try { trace.getSpan(ctx)?.recordException(error); } catch { /* ignore */ }
        safeEnd('ERROR', errorAttrs(error));
        throw err;
      }

      if (result && typeof result.then === 'function') {
        return result.then(
          (v: any) => { safeEnd('OK', ioAttr('function.result', v, captureIO)); return v; },
          (e: any) => {
            const error = e instanceof Error ? e : new Error(String(e));
            try { trace.getSpan(ctx)?.recordException(error); } catch { /* ignore */ }
            safeEnd('ERROR', errorAttrs(error));
            throw e;
          },
        ) as any;
      }

      safeEnd('OK', ioAttr('function.result', result, captureIO));
      return result;
    } as T;
  }

  /**
   * Like traceFunction but emits a first-class tool_call span (renders in the
   * Input/Output panels and counts toward tool metrics). Use it to wrap your own
   * client-side tools so they behave like server-side / LangChain tools.
   */
  traceTool<T extends (...args: any[]) => any>(
    name: string,
    fn: T,
    attributes?: Record<string, string | number | boolean>,
    captureIO: boolean = true,
  ): T {
    const self = this;
    return function (this: any, ...args: any[]) {
      let ctx: OtelContext;
      let end: (status?: 'OK' | 'ERROR', extra?: Record<string, string | number | boolean>) => void;
      try {
        const startAttrs: Record<string, string | number | boolean> = {
          'evalkit.span_type': 'tool_call',
          'tool.name': name,
          'gen_ai.tool.name': name,
          ...attributes,
          ...(captureIO && args.length ? ioAttr('tool.arguments', args.length === 1 ? args[0] : args, captureIO) : undefined),
        };
        const s = self.startSpan(name, startAttrs);
        ctx = s.ctx; end = s.end;
      } catch {
        return fn.apply(this, args);
      }

      const safeEnd = (status: 'OK' | 'ERROR', extra?: Record<string, string | number | boolean>) => {
        try { end(status, extra); } catch { /* never throw from tracing */ }
      };

      let result: any;
      try {
        result = context.with(ctx, () => fn.apply(this, args));
      } catch (err: any) {
        const error = err instanceof Error ? err : new Error(String(err));
        try { trace.getSpan(ctx)?.recordException(error); } catch { /* ignore */ }
        safeEnd('ERROR', errorAttrs(error));
        throw err;
      }

      if (result && typeof result.then === 'function') {
        return result.then(
          (v: any) => { safeEnd('OK', ioAttr('tool.result', v, captureIO)); return v; },
          (e: any) => {
            const error = e instanceof Error ? e : new Error(String(e));
            try { trace.getSpan(ctx)?.recordException(error); } catch { /* ignore */ }
            safeEnd('ERROR', errorAttrs(error));
            throw e;
          },
        ) as any;
      }

      safeEnd('OK', ioAttr('tool.result', result, captureIO));
      return result;
    } as T;
  }

  async flush(): Promise<void> {
    await this.provider.forceFlush();
  }

  async destroy(): Promise<void> {
    await this.provider.shutdown();
  }
}
