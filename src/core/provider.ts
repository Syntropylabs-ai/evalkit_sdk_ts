import { trace } from "@opentelemetry/api";
import type { TracerProvider } from "@opentelemetry/api";
import type { SpanProcessor } from "@opentelemetry/sdk-trace-base";
import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { ATTR_SERVICE_NAME } from "@opentelemetry/semantic-conventions";
import type { Context as OtelContext } from "@opentelemetry/api";
import type { ReadableSpan, Span } from "@opentelemetry/sdk-trace-base";
import { EvalKitExporter, markSdkResource } from "./exporter.js";
import type { MaskHook } from "./redact.js";
import { activePromptRef, promptAttributes } from "./prompt-context.js";
import { captureStartScope } from "./identity.js";
import { noteSpanEnd, noteSpanStart } from "./framework-spans.js";
import { DEFAULT_MAX_QUEUE_BYTES, DEFAULT_MAX_QUEUE_SIZE, EvalKitBatchProcessor, exportTimeoutFromEnv } from "./batch-processor.js";
import { PipelineCounters } from "./diagnostics.js";
import type { CircuitState, EvalKitStats } from "./diagnostics.js";
import { TRUNCATED_PREFIX, cutMiddle, valueLimitBytes } from "./truncate.js";
import { matchesIgnoredUrl } from "./ignore.js";
import { dropSpan, startsUnderDropped, takeDropped, tracingSuppressed } from "./suppress.js";

export interface SpanPipelineOptions {
  baseUrl: string;
  subscriptionKey: string;
  serviceName: string;
  environment?: string;
  appVersion?: string;
  deviceId?: string;
  debug: boolean;
  maxExportBatchSize: number;
  scheduledDelayMillis: number;
  captureContent: boolean;
  captureSecrets: boolean;
  exportGzip: boolean;
  mask?: MaskHook;
  maxQueueSize?: number;
  maxQueueBytes?: number;
  sampleRate?: number;
}

/** `disabled`: the SDK traces nothing, from invalid options or EVALKIT_DISABLED / OTEL_SDK_DISABLED. */
export type TracingMode = "owned" | "attached" | "isolated" | "disabled";

export interface ResolvedTracing {
  provider: TracerProvider;
  processor: ContextStampingProcessor;
  mode: TracingMode;
}

let warned = false;

function warnOnce(message: string): void {
  if (warned) return;
  warned = true;
  try {
    console.warn(`[evalkit] ${message}`);
  } catch {

  }
}

function isOwnSpan(span: Span): boolean {
  const scope = (span as unknown as { instrumentationScope?: { name?: string }; instrumentationLibrary?: { name?: string } });
  return (scope.instrumentationScope ?? scope.instrumentationLibrary)?.name === "evalkit";
}

/**
 * The SDK's setAttribute for its own spans: a string past the per-value limit keeps its start and its end,
 * and `evalkit.truncated.<key>` records its size. Cut as it is set, a body the size of a model's whole
 * context never sits in memory whole until the span is exported.
 */
function cappedSetAttribute(this: Span, key: string, value: unknown): Span {
  const original = Object.getPrototypeOf(this).setAttribute as (k: string, v: unknown) => Span;
  if (typeof value === "string" && !key.startsWith(TRUNCATED_PREFIX)) {
    const cut = cutMiddle(value, valueLimitBytes());
    if (cut) {
      original.call(this, key, cut.value);
      original.call(this, TRUNCATED_PREFIX + key, cut.originalBytes);
      return this;
    }
  }
  return original.call(this, key, value);
}

function capOwnSpan(span: Span): void {
  const attributes = span.attributes as Record<string, unknown>;
  const limit = valueLimitBytes();
  for (const key of Object.keys(attributes)) {
    const value = attributes[key];
    if (typeof value !== "string") continue;
    const cut = cutMiddle(value, limit);
    if (!cut) continue;
    attributes[key] = cut.value;
    attributes[TRUNCATED_PREFIX + key] = cut.originalBytes;
  }
  const proto = Object.getPrototypeOf(span) as { setAttribute?: unknown };
  if (typeof proto?.setAttribute === "function") {
    (span as unknown as { setAttribute: typeof cappedSetAttribute }).setAttribute = cappedSetAttribute;
  }
}

// SpanKind.CLIENT, read off the span without importing the enum into the hot path.
const CLIENT_KIND = 2;

/**
 * Whether a span that is starting is left out of the export: one started inside an untraced scope (with a
 * parent passed in from outside it, which the tracer itself would not catch), one started under a dropped
 * span, or an outgoing call another instrumentation recorded to a URL `ignoreUrls` matches.
 */
function droppedAtStart(span: Span): boolean {
  if (tracingSuppressed() || startsUnderDropped(span)) return true;
  if ((span as unknown as { kind?: number }).kind !== CLIENT_KIND) return false;
  const a = span.attributes as Record<string, unknown>;
  const url = a["url.full"] ?? a["http.url"];
  return typeof url === "string" && matchesIgnoredUrl(url, a["http.request.method"] ?? a["http.method"]);
}

export class ContextStampingProcessor implements SpanProcessor {
  constructor(private readonly inner: SpanProcessor) {}

  onStart(span: Span, parentContext: OtelContext): void {
    try {
      if (droppedAtStart(span)) {
        dropSpan(span);
        return;
      }
    } catch {

    }
    try {
      captureStartScope(span, parentContext);
    } catch {

    }
    try {
      noteSpanStart(span);
    } catch {

    }
    try {
      if (isOwnSpan(span)) capOwnSpan(span);
    } catch {

    }
    try {
      if (span.attributes["evalkit.span_type"] === "llm_call") {
        const ref = activePromptRef(parentContext);
        if (ref) {
          for (const [key, value] of Object.entries(promptAttributes(ref))) {
            if (span.attributes[key] === undefined) span.setAttribute(key, value);
          }
        }
      }
    } catch {

    }
    this.inner.onStart(span, parentContext);
  }

  onEnd(span: ReadableSpan): void {
    try {
      if (takeDropped(span)) return;
    } catch {

    }
    // Before the batch processor: a framework's model-call span is classified at export by what ended inside it.
    try {
      noteSpanEnd(span);
    } catch {

    }
    this.inner.onEnd(span);
  }

  /** Exports what is queued; resolves to whether the receiver took it. Never rejects. */
  flushAll(): Promise<boolean> {
    const inner = this.inner as { flushAll?: () => Promise<boolean> };
    if (typeof inner.flushAll === "function") return inner.flushAll();
    return this.inner.forceFlush().then(() => true, () => false);
  }

  forceFlush(): Promise<void> {
    return this.inner.forceFlush();
  }

  shutdown(): Promise<void> {
    return this.inner.shutdown();
  }

  abortExport(): void {
    (this.inner as { abortExport?: () => void }).abortExport?.();
  }

  exportFailing(): boolean {
    return !!(this.inner as { exportFailing?: () => boolean }).exportFailing?.();
  }

  stats(): EvalKitStats | undefined {
    const inner = this.inner as { stats?: () => EvalKitStats };
    return typeof inner.stats === "function" ? inner.stats() : undefined;
  }
}

/** The SDK's batch processor with the counters and circuit state `getStats()` reads. */
class StatsBatchProcessor extends EvalKitBatchProcessor {
  constructor(
    private readonly exporterRef: EvalKitExporter,
    options: ConstructorParameters<typeof EvalKitBatchProcessor>[1],
    private readonly sharedCounters: PipelineCounters,
  ) {
    super(exporterRef, options, sharedCounters);
  }

  stats(): EvalKitStats {
    const c = this.sharedCounters;
    const state: CircuitState = this.exporterRef.circuitState();
    return {
      queued: this.queuedSpans,
      queued_bytes: this.queuedSize,
      exported: c.exported,
      dropped_queue_full: c.droppedQueueFull,
      dropped_bytes_budget: c.droppedBytesBudget,
      dropped_export_failed: c.droppedExportFailed,
      sampled_out: c.sampledOut,
      export_failures: c.exportFailures,
      last_error: c.lastError,
      circuit_state: state,
    };
  }
}

export function createSpanProcessor(opts: SpanPipelineOptions): ContextStampingProcessor {
  const counters = new PipelineCounters();
  const exportTimeoutMillis = exportTimeoutFromEnv();
  const exporter = new EvalKitExporter({
    baseUrl: opts.baseUrl,
    subscriptionKey: opts.subscriptionKey,
    serviceName: opts.serviceName,
    environment: opts.environment,
    appVersion: opts.appVersion,
    deviceId: opts.deviceId,
    debug: opts.debug,
    captureContent: opts.captureContent,
    captureSecrets: opts.captureSecrets,
    exportGzip: opts.exportGzip,
    maxExportBatchSize: opts.maxExportBatchSize,
    mask: opts.mask,
    counters,
    exportTimeoutMs: exportTimeoutMillis,
  });
  const batch = new StatsBatchProcessor(exporter, {
    maxExportBatchSize: opts.maxExportBatchSize,
    scheduledDelayMillis: opts.scheduledDelayMillis,
    maxQueueSize: opts.maxQueueSize ?? DEFAULT_MAX_QUEUE_SIZE,
    maxQueueBytes: opts.maxQueueBytes ?? DEFAULT_MAX_QUEUE_BYTES,
    sampleRate: opts.sampleRate ?? 1,
    exportTimeoutMillis,
  }, counters);
  return new ContextStampingProcessor(batch);
}

function processorListOf(provider: unknown): SpanProcessor[] | undefined {
  const active = (provider as { _activeSpanProcessor?: { _spanProcessors?: unknown } } | undefined)
    ?._activeSpanProcessor;
  const list = active?._spanProcessors;
  return Array.isArray(list) ? (list as SpanProcessor[]) : undefined;
}

export function attachSpanProcessor(provider: TracerProvider, processor: SpanProcessor): boolean {
  try {
    const list = processorListOf(provider);
    if (!list) return false;
    if (!list.includes(processor)) list.push(processor);
    return true;
  } catch {
    return false;
  }
}

export function detachSpanProcessor(provider: TracerProvider, processor: SpanProcessor): void {
  try {
    const list = processorListOf(provider);
    if (!list) return;
    const at = list.indexOf(processor);
    if (at >= 0) list.splice(at, 1);
  } catch {

  }
}

export function installedTracerProvider(): TracerProvider | undefined {
  try {
    const current = trace.getTracerProvider() as TracerProvider & {
      getDelegate?: () => TracerProvider;
      _delegate?: TracerProvider;
    };
    if (typeof current.getDelegate !== "function") return current;
    return current._delegate;
  } catch {
    return undefined;
  }
}

// The provider the SDK registered as the global one. It lives as long as the process: a later init()
// attaches its own exporter to it, and spans from libraries that cached a tracer of it keep flowing.
let sdkProvider: TracerProvider | undefined;

function createUnregisteredProvider(serviceName: string, processor: ContextStampingProcessor): NodeTracerProvider {
  const resource = resourceFromAttributes({ [ATTR_SERVICE_NAME]: serviceName });
  // The exporter names the SDK's own spans by its current options, not by the service name this
  // resource was built with, since a later init() reuses the provider.
  markSdkResource(resource);
  return new NodeTracerProvider({ resource, spanProcessors: [processor] });
}

export function resolveTracing(opts: SpanPipelineOptions, explicit?: TracerProvider): ResolvedTracing {
  const processor = createSpanProcessor(opts);

  if (explicit) {
    if (attachSpanProcessor(explicit, processor)) {
      return { provider: explicit, processor, mode: "attached" };
    }
    warnOnce(
      "the TracerProvider passed as options.tracerProvider is not an OpenTelemetry SDK TracerProvider, so EvalKit " +
        "cannot add its exporter to it. EvalKit is tracing through its own provider instead: spans created through " +
        "the EvalKit API are exported, spans from your instrumentation are not, and your exporters will not see " +
        "EvalKit's spans. Pass a provider from @opentelemetry/sdk-trace-node or @opentelemetry/sdk-trace-base."
    );
    return { provider: createUnregisteredProvider(opts.serviceName, processor), processor, mode: "isolated" };
  }

  const installed = installedTracerProvider();
  if (installed && attachSpanProcessor(installed, processor)) {
    return { provider: installed, processor, mode: installed === sdkProvider ? "owned" : "attached" };
  }

  const provider = createUnregisteredProvider(opts.serviceName, processor);

  // register() installs the provider with its context manager and propagator, once: setting the provider
  // first and registering it after would attempt the registration twice.
  if (!installed) {
    try {
      provider.register();
    } catch {

    }
    if (installedTracerProvider() === provider) {
      sdkProvider = provider;
      return { provider, processor, mode: "owned" };
    }
  }

  warnOnce(
    "an OpenTelemetry TracerProvider is already installed and EvalKit could not attach its exporter to it. Spans " +
      "you create through the EvalKit API are still exported, but spans from your own OpenTelemetry " +
      "instrumentation are not. Call evalkit.init() after your OpenTelemetry SDK has started, or pass " +
      "{ tracerProvider } so EvalKit exports through the provider you own."
  );
  return { provider, processor, mode: "isolated" };
}
