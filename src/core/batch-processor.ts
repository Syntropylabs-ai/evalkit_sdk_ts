import { TraceFlags, context, SpanStatusCode } from "@opentelemetry/api";
import type { Context as OtelContext } from "@opentelemetry/api";
import { ExportResultCode, suppressTracing } from "@opentelemetry/core";
import type { ReadableSpan, Span, SpanExporter, SpanProcessor } from "@opentelemetry/sdk-trace-base";
import type { PipelineCounters } from "./diagnostics.js";
import { BoundedMap } from "../utils/bounded-map.js";
import { swallow } from "./guard.js";

export const DEFAULT_MAX_QUEUE_SIZE = 2048;
export const DEFAULT_MAX_QUEUE_BYTES = 32 * 1024 * 1024;
const DEFAULT_EXPORT_TIMEOUT_MS = 30_000;

/** How long one export may take: OTEL_BSP_EXPORT_TIMEOUT, else 30 s. The exporter's own budget fits inside it. */
export function exportTimeoutFromEnv(): number {
  const env = Number(typeof process !== "undefined" ? process.env?.OTEL_BSP_EXPORT_TIMEOUT : undefined);
  return env > 0 ? env : DEFAULT_EXPORT_TIMEOUT_MS;
}

export interface BatchOptions {
  maxExportBatchSize: number;
  scheduledDelayMillis: number;
  maxQueueSize: number;
  maxQueueBytes: number;
  /** 1 keeps every trace. */
  sampleRate: number;
  exportTimeoutMillis?: number;
}

/**
 * The exporter side the processor needs: whether spans would be accepted at all right now, and whether an
 * export the processor stopped waiting for is still running (the processor then waits for it to finish).
 */
export interface GatedExporter extends SpanExporter {
  accepting(): boolean;
  isBusy?(): boolean;
  isFailing?(): boolean;
  whenIdle?(): Promise<void>;
  abort?(): void;
}

interface Entry {
  span: ReadableSpan;
  bytes: number;
  priority: boolean;
}

function attrs(span: ReadableSpan): Record<string, unknown> {
  return (span.attributes ?? {}) as Record<string, unknown>;
}

/** A model call: the span the queue keeps longest when memory runs short. */
function isModelCall(span: ReadableSpan): boolean {
  const a = attrs(span);
  if (a["evalkit.span_type"] === "llm_call") return true;
  if (a["evalkit.span_type"] !== undefined) return false;
  return a["gen_ai.request.model"] !== undefined || a["gen_ai.system"] !== undefined || a["gen_ai.provider.name"] !== undefined;
}

function valueBytes(v: unknown): number {
  if (typeof v === "string") return v.length;
  if (Array.isArray(v)) {
    let n = 0;
    for (const item of v) n += typeof item === "string" ? item.length + 4 : 8;
    return n;
  }
  return 8;
}

/**
 * What a span holds in memory, roughly: its strings by length (one byte a character for the ASCII most
 * attributes are) and a fixed cost for the rest. Cheap enough to run on every span that ends.
 */
export function estimateSpanBytes(span: ReadableSpan): number {
  let n = 256 + (span.name?.length ?? 0);
  const a = attrs(span);
  for (const key in a) n += key.length + 16 + valueBytes(a[key]);
  for (const event of span.events ?? []) {
    n += 64 + (event.name?.length ?? 0);
    const ea = (event.attributes ?? {}) as Record<string, unknown>;
    for (const key in ea) n += key.length + 16 + valueBytes(ea[key]);
  }
  return n;
}

// OpenTelemetry's TraceIdRatioBasedSampler arithmetic, so a trace kept here is kept by any service sampling
// at the same ratio the OpenTelemetry way.
function traceIdKept(traceId: string, ratio: number): boolean {
  if (ratio >= 1) return true;
  if (ratio <= 0) return false;
  let accumulation = 0;
  for (let i = 0; i < traceId.length / 8; i++) {
    const part = parseInt(traceId.slice(i * 8, i * 8 + 8), 16);
    accumulation = (accumulation ^ (Number.isNaN(part) ? 0 : part)) >>> 0;
  }
  return accumulation <= Math.floor(ratio * 0xffffffff);
}

/**
 * Decides which ended spans are kept under `sampleRate`: whole traces by trace id, so a kept trace keeps all
 * of its spans; a trace whose parent came sampled from another service, as that service decided; and always
 * every model call, tool call and errored span, whatever their trace.
 */
export class TraceSampler {
  private readonly remoteKept = new BoundedMap<string, true>(10_000, 60 * 60_000);

  constructor(readonly rate: number) {}

  onStart(span: Span): void {
    if (this.rate >= 1) return;
    const parent = (span as unknown as { parentSpanContext?: { isRemote?: boolean; traceFlags?: number } }).parentSpanContext;
    if (parent?.isRemote && ((parent.traceFlags ?? 0) & TraceFlags.SAMPLED) !== 0) {
      this.remoteKept.set(span.spanContext().traceId, true);
    }
  }

  keep(span: ReadableSpan): boolean {
    if (this.rate >= 1) return true;
    if (span.status?.code === SpanStatusCode.ERROR) return true;
    const a = attrs(span);
    const type = a["evalkit.span_type"];
    if (type === "llm_call" || type === "tool_call") return true;
    if (type === undefined && (a["gen_ai.operation.name"] !== undefined || a["gen_ai.request.model"] !== undefined || a["gen_ai.tool.name"] !== undefined)) {
      return true;
    }
    const traceId = span.spanContext().traceId;
    if (this.remoteKept.has(traceId)) return true;
    return traceIdKept(traceId, this.rate);
  }
}

/**
 * Batches ended spans for the exporter within a bounded queue: at most `maxQueueSize` spans and about
 * `maxQueueBytes` of memory, where a model call displaces other spans before it is ever dropped itself. One
 * export is in flight at a time; spans ending meanwhile wait in the queue, and what does not fit is
 * counted and dropped. Nothing here throws into the app or rejects: flushing resolves whether or not the
 * receiver took the spans, and `flushAll()` says which.
 */
export class EvalKitBatchProcessor implements SpanProcessor {
  private queue: Entry[] = [];
  private queuedBytes = 0;
  private inFlight: Promise<boolean> | undefined;
  private inFlightCount = 0;
  private inFlightBytes = 0;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private stopped = false;
  private readonly batchSize: number;
  private readonly exportTimeout: number;
  readonly sampler: TraceSampler;

  constructor(
    private readonly exporter: GatedExporter,
    private readonly options: BatchOptions,
    private readonly counters: PipelineCounters,
  ) {
    this.batchSize = Math.max(1, Math.min(options.maxExportBatchSize, options.maxQueueSize));
    this.exportTimeout = options.exportTimeoutMillis ?? exportTimeoutFromEnv();
    this.sampler = new TraceSampler(options.sampleRate);
  }

  get queuedSpans(): number {
    return this.queue.length + this.inFlightCount;
  }

  get queuedSize(): number {
    return this.queuedBytes + this.inFlightBytes;
  }

  onStart(span: Span, _parentContext: OtelContext): void {
    try {
      this.sampler.onStart(span);
    } catch (err) {
      swallow("sampling a span", err);
    }
  }

  onEnd(span: ReadableSpan): void {
    if (this.stopped) return;
    try {
      if ((span.spanContext().traceFlags & TraceFlags.SAMPLED) === 0) return;
      if (!this.sampler.keep(span)) {
        this.counters.sampledOut++;
        return;
      }
      // An open circuit or a refused key drops spans here, before they cost any memory.
      if (!this.exporter.accepting()) {
        this.counters.droppedExportFailed++;
        return;
      }
      const entry: Entry = { span, bytes: estimateSpanBytes(span), priority: isModelCall(span) };
      if (!this.makeRoom(entry)) return;
      this.queue.push(entry);
      this.queuedBytes += entry.bytes;
      if (this.queue.length >= this.batchSize) this.exportNext();
      else this.startTimer();
    } catch (err) {
      swallow("queueing a span", err);
    }
  }

  /**
   * Frees room for `entry` by dropping other spans when it is a model call; false when it must be dropped.
   * Spans are dropped for it only when that makes room: a model call too large for the budget even then is
   * dropped alone.
   */
  private makeRoom(entry: Entry): boolean {
    const overBudget = this.queuedBytes + this.inFlightBytes + entry.bytes > this.options.maxQueueBytes;
    const full = this.queue.length >= this.options.maxQueueSize;
    if (!full && !overBudget) return true;
    if (!entry.priority) {
      if (full) this.counters.droppedQueueFull++;
      else this.counters.droppedBytesBudget++;
      return false;
    }
    let evictable = 0;
    let evictableBytes = 0;
    for (const e of this.queue) {
      if (e.priority) continue;
      evictable++;
      evictableBytes += e.bytes;
    }
    const fitsAfter = this.queuedBytes - evictableBytes + this.inFlightBytes + entry.bytes <= this.options.maxQueueBytes;
    if ((full && evictable === 0) || (overBudget && !fitsAfter)) {
      if (full) this.counters.droppedQueueFull++;
      else this.counters.droppedBytesBudget++;
      return false;
    }
    if (full) {
      this.evictOne();
      this.counters.droppedQueueFull++;
    }
    while (this.queuedBytes + this.inFlightBytes + entry.bytes > this.options.maxQueueBytes && this.evictOne()) {
      this.counters.droppedBytesBudget++;
    }
    return true;
  }

  /** Drops the oldest queued span that is not a model call. */
  private evictOne(): boolean {
    const at = this.queue.findIndex((e) => !e.priority);
    if (at < 0) return false;
    const [gone] = this.queue.splice(at, 1);
    this.queuedBytes -= gone.bytes;
    return true;
  }

  private startTimer(): void {
    if (this.timer !== undefined || this.inFlight) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.exportNext();
    }, this.options.scheduledDelayMillis);
    (this.timer as { unref?: () => void }).unref?.();
  }

  private clearTimer(): void {
    if (this.timer === undefined) return;
    clearTimeout(this.timer);
    this.timer = undefined;
  }

  /** Starts exporting the next batch unless one is in flight; resolves to whether that export succeeded. */
  private exportNext(): Promise<boolean> {
    if (this.inFlight) return this.inFlight;
    if (this.queue.length === 0) return Promise.resolve(true);
    this.clearTimer();
    // An export the watchdog stopped waiting for is still running: the queue waits for it rather than
    // handing the exporter a batch it would have to refuse.
    if (this.exporter.isBusy?.() && typeof this.exporter.whenIdle === "function") {
      const waiting = this.exporter.whenIdle().then(() => false, () => false);
      this.inFlight = waiting;
      void waiting.then(() => {
        this.inFlight = undefined;
        if (this.stopped) return;
        if (this.queue.length >= this.batchSize) this.exportNext();
        else if (this.queue.length > 0) this.startTimer();
      });
      return waiting;
    }
    const batch = this.queue.splice(0, this.batchSize);
    let bytes = 0;
    for (const e of batch) bytes += e.bytes;
    this.queuedBytes -= bytes;
    this.inFlightCount = batch.length;
    this.inFlightBytes = bytes;
    const done = this.exportBatch(batch.map((e) => e.span));
    this.inFlight = done;
    void done.then(() => {
      this.inFlight = undefined;
      this.inFlightCount = 0;
      this.inFlightBytes = 0;
      if (this.stopped) return;
      if (this.queue.length >= this.batchSize) this.exportNext();
      else if (this.queue.length > 0) this.startTimer();
    });
    return done;
  }

  private exportBatch(spans: ReadableSpan[]): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      let settled = false;
      const settle = (ok: boolean): void => {
        if (settled) return;
        settled = true;
        clearTimeout(watchdog);
        resolve(ok);
      };
      // The exporter bounds its own requests; this only keeps a broken one from holding the queue forever.
      const watchdog = setTimeout(() => settle(false), this.exportTimeout);
      (watchdog as { unref?: () => void }).unref?.();
      const run = (): void => {
        try {
          // The export's own requests must not be traced, or every export would record more spans.
          context.with(suppressTracing(context.active()), () => {
            this.exporter.export(spans, (result) => settle(result.code === ExportResultCode.SUCCESS));
          });
        } catch (err) {
          swallow("exporting spans", err);
          settle(false);
        }
      };
      const pending: Promise<unknown>[] = [];
      for (const span of spans) {
        const resource = span.resource as { asyncAttributesPending?: boolean; waitForAsyncAttributes?: () => Promise<unknown> } | undefined;
        if (resource?.asyncAttributesPending && typeof resource.waitForAsyncAttributes === "function") {
          pending.push(resource.waitForAsyncAttributes());
        }
      }
      if (pending.length === 0) run();
      else Promise.all(pending).then(run, () => run());
    });
  }

  /**
   * Exports everything queued when it was called, one batch after another, and resolves to whether every
   * export succeeded. Spans that end meanwhile go with the next scheduled export.
   */
  async flushAll(): Promise<boolean> {
    let ok = true;
    try {
      // Each round waits for the export in flight or starts the next one; an export that ends starts the
      // next full batch itself, so every batch queued now may need two rounds. The bound keeps a flush from
      // chasing spans an app keeps ending while it runs.
      let rounds = 2 * (Math.ceil(this.queue.length / this.batchSize) + 1) + 1;
      while (rounds-- > 0) {
        if (this.inFlight) {
          ok = (await this.inFlight) && ok;
          continue;
        }
        if (this.queue.length === 0) break;
        ok = (await this.exportNext()) && ok;
      }
    } catch (err) {
      swallow("flushing spans", err);
      return false;
    }
    return ok;
  }

  forceFlush(): Promise<void> {
    return this.flushAll().then(() => undefined, () => undefined);
  }

  /** Whether the export in flight already failed a request. */
  exportFailing(): boolean {
    try {
      return !!this.exporter.isFailing?.();
    } catch {
      return false;
    }
  }

  /** Abandons the export in flight, for a process on its way out that cannot wait for it any longer. */
  abortExport(): void {
    try {
      this.exporter.abort?.();
    } catch (err) {
      swallow("abandoning an export", err);
    }
  }

  async shutdown(): Promise<void> {
    if (this.stopped) return;
    try {
      await this.flushAll();
    } finally {
      this.stopped = true;
      this.clearTimer();
      try {
        await this.exporter.shutdown();
      } catch (err) {
        swallow("shutting down the exporter", err);
      }
    }
  }
}
