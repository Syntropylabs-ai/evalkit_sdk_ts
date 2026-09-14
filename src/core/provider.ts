import { trace } from "@opentelemetry/api";
import type { TracerProvider } from "@opentelemetry/api";
import { BatchSpanProcessor } from "@opentelemetry/sdk-trace-base";
import type { SpanProcessor } from "@opentelemetry/sdk-trace-base";
import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { ATTR_SERVICE_NAME } from "@opentelemetry/semantic-conventions";
import type { Context as OtelContext } from "@opentelemetry/api";
import type { ReadableSpan, Span } from "@opentelemetry/sdk-trace-base";
import { EvalKitExporter } from "./exporter.js";
import type { MaskHook } from "./redact.js";
import { activePromptRef, promptAttributes } from "./prompt-context.js";

export interface SpanPipelineOptions {
  baseUrl: string;
  subscriptionKey: string;
  serviceName: string;
  debug: boolean;
  maxExportBatchSize: number;
  scheduledDelayMillis: number;
  captureContent: boolean;
  captureSecrets: boolean;
  mask?: MaskHook;
}

export type TracingMode = "owned" | "attached" | "isolated";

export interface ResolvedTracing {
  provider: TracerProvider;
  processor: SpanProcessor;
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

class ContextStampingProcessor implements SpanProcessor {
  constructor(private readonly inner: SpanProcessor) {}

  onStart(span: Span, parentContext: OtelContext): void {
    if (span.attributes["evalkit.span_type"] === "llm_call") {
      const ref = activePromptRef(parentContext);
      if (ref) {
        for (const [key, value] of Object.entries(promptAttributes(ref))) {
          if (span.attributes[key] === undefined) span.setAttribute(key, value);
        }
      }
    }
    this.inner.onStart(span, parentContext);
  }

  onEnd(span: ReadableSpan): void {
    this.inner.onEnd(span);
  }

  forceFlush(): Promise<void> {
    return this.inner.forceFlush();
  }

  shutdown(): Promise<void> {
    return this.inner.shutdown();
  }
}

export function createSpanProcessor(opts: SpanPipelineOptions): SpanProcessor {
  const exporter = new EvalKitExporter({
    baseUrl: opts.baseUrl,
    subscriptionKey: opts.subscriptionKey,
    serviceName: opts.serviceName,
    debug: opts.debug,
    captureContent: opts.captureContent,
    captureSecrets: opts.captureSecrets,
    mask: opts.mask,
  });
  const batch = new BatchSpanProcessor(exporter, {
    maxExportBatchSize: opts.maxExportBatchSize,
    scheduledDelayMillis: opts.scheduledDelayMillis,
  });
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

function createUnregisteredProvider(serviceName: string, processor: SpanProcessor): NodeTracerProvider {
  return new NodeTracerProvider({
    resource: resourceFromAttributes({ [ATTR_SERVICE_NAME]: serviceName }),
    spanProcessors: [processor],
  });
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
    return { provider: installed, processor, mode: "attached" };
  }

  const provider = createUnregisteredProvider(opts.serviceName, processor);

  if (trace.setGlobalTracerProvider(provider)) {
    provider.register();
    return { provider, processor, mode: "owned" };
  }

  warnOnce(
    "an OpenTelemetry TracerProvider is already installed and EvalKit could not attach its exporter to it. Spans " +
      "you create through the EvalKit API are still exported, but spans from your own OpenTelemetry " +
      "instrumentation are not. Call evalkit.init() after your OpenTelemetry SDK has started, or pass " +
      "{ tracerProvider } so EvalKit exports through the provider you own."
  );
  return { provider, processor, mode: "isolated" };
}
