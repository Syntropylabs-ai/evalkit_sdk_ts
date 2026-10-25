import type { ReadableSpan } from "@opentelemetry/sdk-trace-base";
import { ExportResultCode } from "@opentelemetry/core";
import type { ExportResult } from "@opentelemetry/core";
import type { TraceEnvelope, SpanEvent } from "./types.js";
import { simByTraceId } from "./simulation.js";
import { agentAttributes, agentNameOf, scopeForSpan, sessionIdOf, userIdOf } from "./identity.js";
import { frameworkSpanFields } from "./framework-spans.js";
import { applyMask, envFlag, stripContent } from "./redact.js";
import { scrubSecrets } from "./secrets.js";
import type { MaskHook } from "./redact.js";
import { RETRY_BUDGET_MS, isRetryableStatus, retryDelayMs } from "./retry.js";
import { FailureReporter, PipelineCounters, cutReason, sdkLog } from "./diagnostics.js";
import type { CircuitState } from "./diagnostics.js";
import type { GatedExporter } from "./batch-processor.js";
import { TRUNCATED_PREFIX, cutMiddle, utf8Length, valueLimitBytes } from "./truncate.js";
import { EXCEPTION_EVENT, normaliseExceptionEvent } from "./exceptions.js";
import { swallow } from "./guard.js";

const AUTH_FAIL_LIMIT = 3;

// The most one span may take as JSON, in UTF-8 bytes: the 16 MiB a single request may carry through the
// proxy in front of the receiver. Compression usually brings a span this size far below that.
const MAX_SPAN_BYTES = 16 * 1024 * 1024;

// The most JSON one export request carries, measured before compression. A batch of large spans goes out
// as several requests, so no request comes near the 16 MiB that the proxy in front of the receiver accepts,
// and a refused request costs only its own spans, not the whole batch.
const MAX_REQUEST_BYTES = 4 * 1024 * 1024;

// One attempt waits at most this long for the receiver, and never past the export's budget: fetch has no
// timeout of its own, and a receiver that accepts the connection and never answers would hold the export,
// and the queue behind it, forever. An attempt started at the end of the budget still gets a second.
const ATTEMPT_TIMEOUT_MS = 10_000;
const MIN_ATTEMPT_TIMEOUT_MS = 1_000;

// The circuit opens after this many export cycles in a row failed for want of the receiver (no answer, 5xx,
// 429), and stays open for the cooldown, doubled after every failed probe up to the cap.
const CIRCUIT_FAILURES = 3;
const CIRCUIT_COOLDOWN_MS = 30_000;
const CIRCUIT_MAX_COOLDOWN_MS = 5 * 60_000;
// What the probe that tests a closed receiver sends: one small request.
const PROBE_SPANS = 16;
const PROBE_BYTES = 256 * 1024;

const DEFAULT_MAX_REQUEST_SPANS = 512;

export const EXPORT_GZIP_ENV_VARS = ["EVALKIT_EXPORT_GZIP"] as const;

// zlib's default: close to the ratio of level 9 for a fraction of the CPU time.
const GZIP_LEVEL = 6;

// zlib is loaded on first use: an app that never exports compressed never loads it.
let gzipFn: ((body: Uint8Array, options: { level: number }) => Promise<Buffer>) | undefined;

async function gzipBody(body: Uint8Array): Promise<Buffer> {
  if (!gzipFn) {
    const zlib = await import("node:zlib");
    const gzip = zlib.gzip ?? (zlib as unknown as { default: typeof zlib }).default.gzip;
    gzipFn = (input, options) =>
      new Promise((resolve, reject) => gzip(input, options, (err, out) => (err ? reject(err) : resolve(out))));
  }
  return gzipFn(body, { level: GZIP_LEVEL });
}

function timeoutReason(): Error {
  if (typeof DOMException === "function") return new DOMException("the export attempt timed out", "TimeoutError");
  return Object.assign(new Error("the export attempt timed out"), { name: "TimeoutError" });
}

/** A signal that aborts after `ms`, or as soon as the export it belongs to is abandoned. */
function attemptSignal(ms: number, cycle?: AbortSignal): { signal?: AbortSignal; done: () => void } {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(timeoutReason()), ms);
    (timer as { unref?: () => void }).unref?.();
    const onAbandon = (): void => controller.abort(cycle?.reason);
    if (cycle?.aborted) controller.abort(cycle.reason);
    else cycle?.addEventListener("abort", onAbandon, { once: true });
    return {
      signal: controller.signal,
      done: () => {
        clearTimeout(timer);
        cycle?.removeEventListener("abort", onAbandon);
      },
    };
  } catch {
    return { done: () => {} };
  }
}

const BODY_OVERHEAD = '{"events":[]}'.length;

// Resources the SDK built for its own providers. Their service name is the one of the init() that created the
// provider; spans under them are named by the exporter's options, which belong to the init() in force.
const sdkResources = new WeakSet<object>();

export function markSdkResource(resource: object): void {
  sdkResources.add(resource);
}

export function resolveExportGzip(explicit?: boolean): boolean {
  if (explicit !== undefined) return explicit;
  for (const name of EXPORT_GZIP_ENV_VARS) {
    const flag = envFlag(name);
    if (flag !== undefined) return flag;
  }
  return true;
}

interface EncodedSpan {
  json: string;
  bytes: number;
  operation: string;
}

// "refused": the receiver refused this request's spans, and the next request may still be accepted.
// "halt": no answer, only 5xx or 429 ones, or a refused key, so every later request would meet the same failure.
type Outcome = "sent" | "refused" | "halt";

// How one export cycle ended, for the circuit breaker: only a receiver that could not be reached or would
// not take anything counts toward opening it. A refused key has its own limit.
type CycleResult = "ok" | "refused" | "unreachable" | "auth";

const CACHE_READ_KEYS = [
  "gen_ai.usage.cache_read_tokens",
  "gen_ai.usage.cache_read.input_tokens",
  "gen_ai.usage.cached_tokens",
] as const;

const CACHE_CREATION_KEYS = [
  "gen_ai.usage.cache_creation_tokens",
  "gen_ai.usage.cache_creation.input_tokens",
  "gen_ai.usage.cache_write.input_tokens",
] as const;

const TOKENS_IN_KEYS = [
  "gen_ai.usage.input_tokens",
  "gen_ai.usage.prompt_tokens",
] as const;

const TOKENS_OUT_KEYS = [
  "gen_ai.usage.output_tokens",
  "gen_ai.usage.completion_tokens",
] as const;

const PROMOTED_ATTRIBUTES: ReadonlySet<string> = new Set([
  "gen_ai.system",
  "gen_ai.provider.name",
  "evalkit.span_type",
  "evalkit.prompt",
  "evalkit.completion",
  "evalkit.environment",
  "evalkit.app_version",
  "evalkit.user_id",
  "evalkit.session_id",
  "evalkit.device_id",
  "evalkit.sdk_version",
]);

function firstTokenCount(
  attrs: Record<string, unknown>,
  keys: readonly string[]
): number | undefined {
  for (const key of keys) {
    const raw = Number(attrs[key]);
    if (!Number.isFinite(raw)) continue;
    const n = Math.round(raw);
    if (n > 0) return n;
  }
  return undefined;
}

function foldExclusiveCache(
  tokensIn: number | undefined,
  cacheRead: number | undefined,
  cacheCreation: number | undefined
): number | undefined {
  const cached = (cacheRead ?? 0) + (cacheCreation ?? 0);
  if (tokensIn === undefined || cached === 0) return tokensIn;
  return tokensIn < cached ? tokensIn + cached : tokensIn;
}

export class EvalKitExporter implements GatedExporter {
  private readonly url: string;
  private readonly subscriptionKey: string;
  private readonly serviceName?: string;
  private readonly environment?: string;
  private readonly appVersion?: string;
  private readonly deviceId?: string;
  private readonly debug: boolean;
  private readonly captureContent: boolean;
  private readonly captureSecrets: boolean;
  private readonly mask?: MaskHook;
  private readonly maxRequestSpans: number;
  private gzip: boolean;
  private authFailures = 0;
  private disabled = false;
  private clock: () => number = Date.now;
  private pause: (ms: number) => Promise<void> = (ms) => sleep(ms, this.cycle?.signal);
  private busy = false;
  private idleWaiters: Array<() => void> = [];
  private cycle: AbortController | undefined;
  private readonly budgetMs: number;
  private consecutiveFailures = 0;
  private circuit: "closed" | "open" | "half_open" = "closed";
  private openUntil = 0;
  private cooldown = CIRCUIT_COOLDOWN_MS;
  private lastCycle: CycleResult = "ok";
  // Why the current cycle's requests failed, reported once the cycle ends.
  private lastReason = "";
  // Whether an attempt of the current cycle failed, retried or not.
  private attemptFailed = false;
  readonly counters: PipelineCounters;
  private readonly reporter: FailureReporter;

  constructor(opts: {
    baseUrl: string;
    subscriptionKey: string;
    serviceName?: string;
    environment?: string;
    appVersion?: string;
    deviceId?: string;
    debug?: boolean;
    captureContent?: boolean;
    captureSecrets?: boolean;
    exportGzip?: boolean;
    maxExportBatchSize?: number;
    mask?: MaskHook;
    counters?: PipelineCounters;
    /** How long the caller waits for one export; the retry budget ends two seconds before it. */
    exportTimeoutMs?: number;
  }) {
    this.url = `${opts.baseUrl.replace(/\/$/, "")}/v1/ingest`;
    this.subscriptionKey = opts.subscriptionKey;
    this.serviceName = opts.serviceName;
    this.environment = opts.environment || undefined;
    this.appVersion = opts.appVersion || undefined;
    this.deviceId = opts.deviceId || undefined;
    this.debug = opts.debug ?? false;
    this.captureContent = opts.captureContent ?? true;
    this.captureSecrets = opts.captureSecrets ?? false;
    this.gzip = opts.exportGzip ?? resolveExportGzip();
    const maxSpans = Math.floor(Number(opts.maxExportBatchSize));
    this.maxRequestSpans = maxSpans >= 1 ? maxSpans : DEFAULT_MAX_REQUEST_SPANS;
    this.mask = opts.mask;
    this.counters = opts.counters ?? new PipelineCounters();
    this.reporter = new FailureReporter(this.counters, this.debug, () => this.clock());
    // An attempt started at the deadline still has up to a second, and gzip and the body read take a
    // moment, so the export ends before whoever waits for it gives up.
    const timeout = Number(opts.exportTimeoutMs);
    this.budgetMs = timeout > 0 ? Math.max(1000, Math.min(RETRY_BUDGET_MS, timeout - 2000)) : RETRY_BUDGET_MS;
  }

  isBusy(): boolean {
    return this.busy;
  }

  /** Whether the export in flight has already seen a request fail: a receiver unreachable right now. */
  isFailing(): boolean {
    return this.busy && (this.attemptFailed || this.lastReason !== "");
  }

  /** Resolves once no export is running. */
  whenIdle(): Promise<void> {
    if (!this.busy) return Promise.resolve();
    return new Promise((resolve) => this.idleWaiters.push(resolve));
  }

  /** Abandons the export in flight: its requests are aborted and no further request or retry is made. */
  abort(): void {
    try {
      this.cycle?.abort(Object.assign(new Error("the export was abandoned"), { name: "AbortError" }));
    } catch {
      // Nothing in flight to abandon.
    }
  }

  private setIdle(): void {
    this.busy = false;
    this.cycle = undefined;
    const waiters = this.idleWaiters;
    this.idleWaiters = [];
    for (const resolve of waiters) {
      try {
        resolve();
      } catch {
        // A waiter's own concern.
      }
    }
  }

  /** Whether spans would be sent now; false while the circuit is open or after the key was refused. */
  accepting(): boolean {
    if (this.disabled) return false;
    return this.circuit !== "open" || this.clock() >= this.openUntil;
  }

  circuitState(): CircuitState {
    if (this.disabled) return "disabled";
    if (this.circuit === "open" && this.clock() >= this.openUntil) return "half_open";
    return this.circuit;
  }

  private redact(envelope: TraceEnvelope): TraceEnvelope | null {
    const stripped = this.captureContent ? envelope : stripContent(envelope);
    const scrubbed = this.captureSecrets ? stripped : scrubSecrets(stripped);
    return this.mask ? applyMask(this.mask, scrubbed) : scrubbed;
  }

  private serviceNameFor(span: ReadableSpan): string | undefined {
    const fromResource = span.resource?.attributes["service.name"] as string | undefined;
    const sdkOwned = !!span.resource && sdkResources.has(span.resource);
    if (this.serviceName && (sdkOwned || !fromResource || fromResource.startsWith("unknown_service"))) {
      return this.serviceName;
    }
    return fromResource;
  }

  export(spans: ReadableSpan[], resultCallback: (result: ExportResult) => void): void {
    const callback = (ok: boolean): void => {
      try {
        resultCallback({ code: ok ? ExportResultCode.SUCCESS : ExportResultCode.FAILED });
      } catch {
        // The caller's callback is its own concern.
      }
    };
    if (this.disabled) {
      this.counters.droppedExportFailed += spans.length;
      callback(false);
      return;
    }
    // One export at a time: a second one while the first still waits on the receiver would only pile
    // requests onto a receiver that is already slow.
    if (this.busy) {
      this.counters.droppedExportFailed += spans.length;
      callback(false);
      return;
    }
    let probe = false;
    if (this.circuit === "open") {
      if (this.clock() < this.openUntil) {
        this.counters.droppedExportFailed += spans.length;
        callback(false);
        return;
      }
      this.circuit = "half_open";
    }
    if (this.circuit === "half_open") probe = true;

    // A span that cannot be encoded (an attribute a library left unreadable) costs only itself.
    const encoded: EncodedSpan[] = [];
    for (const s of spans) {
      try {
        const scope = (s as any).instrumentationScope?.name ?? (s as any).instrumentationLibrary?.name;
        if (scope === "gcp.vertex.agent") continue;
        const envelope = this.redact(this.toEnvelope(s));
        if (envelope === null) continue;
        const one = encodeEnvelope(envelope, this.debug);
        if (one) encoded.push(one);
      } catch (err) {
        this.counters.droppedExportFailed++;
        swallow("encoding a span", err);
      }
    }

    if (encoded.length === 0) {
      callback(true);
      return;
    }

    if (this.debug) {
      console.log(`[evalkit] sending ${encoded.length} span(s) → ${this.url}`);
    }

    this.busy = true;
    this.cycle = typeof AbortController === "function" ? new AbortController() : undefined;
    this.sendAll(encoded, this.clock() + this.budgetMs, probe).then(
      (sent) => {
        this.setIdle();
        this.endCycle(encoded.length, sent);
        callback(sent === encoded.length);
      },
      (err) => {
        this.setIdle();
        this.lastCycle = "unreachable";
        this.lastReason = `export error: ${cutReason(err)}`;
        this.endCycle(encoded.length, 0);
        callback(false);
      },
    );
  }

  /** Counts a finished export cycle and moves the circuit: closed on success, open after repeated failures. */
  private endCycle(total: number, sent: number): void {
    this.counters.exported += sent;
    this.counters.droppedExportFailed += total - sent;
    const result = this.lastCycle;
    if (sent < total) {
      this.counters.exportFailures++;
      // A refused key is reported where it is counted, a span refused as too large where it is dropped.
      if (result !== "auth" && this.lastReason) this.reporter.failure(this.lastReason, total - sent);
    }
    if (result === "ok") {
      this.consecutiveFailures = 0;
      if (this.circuit !== "closed") {
        this.circuit = "closed";
        this.cooldown = CIRCUIT_COOLDOWN_MS;
      }
      if (sent === total) this.reporter.recovered();
      return;
    }
    if (result !== "unreachable") {
      // A refused body or key says the receiver is up; only its own limits apply.
      if (this.circuit === "half_open") this.circuit = "closed";
      this.consecutiveFailures = 0;
      return;
    }
    this.consecutiveFailures++;
    if (this.circuit === "half_open") {
      this.cooldown = Math.min(this.cooldown * 2, CIRCUIT_MAX_COOLDOWN_MS);
      this.openCircuit();
    } else if (this.consecutiveFailures >= CIRCUIT_FAILURES) {
      this.cooldown = CIRCUIT_COOLDOWN_MS;
      this.openCircuit();
    }
  }

  private openCircuit(): void {
    this.circuit = "open";
    this.openUntil = this.clock() + this.cooldown;
    if (this.debug) {
      sdkLog("warn", `[evalkit] export circuit open for ${Math.round(this.cooldown / 1000)} s after repeated failures; spans are dropped until a probe succeeds`);
    }
  }

  /** Sends the spans in requests; resolves to how many the receiver accepted. */
  private async sendAll(spans: EncodedSpan[], deadline: number, probe = false): Promise<number> {
    this.lastCycle = "ok";
    this.lastReason = "";
    this.attemptFailed = false;
    let sent = 0;
    let rest = spans;
    if (probe) {
      // A receiver that just failed is tested with one small request before the rest is sent to it.
      const first: EncodedSpan[] = [];
      let bytes = BODY_OVERHEAD;
      for (const span of spans) {
        if (first.length > 0 && (first.length >= PROBE_SPANS || bytes + span.bytes > PROBE_BYTES)) break;
        first.push(span);
        bytes += span.bytes + 1;
      }
      const outcome = await this.send(first, deadline);
      if (outcome === "sent") sent += first.length;
      if (outcome === "halt") return sent;
      rest = spans.slice(first.length);
    }
    for (const group of groupForRequests(rest, MAX_REQUEST_BYTES, this.maxRequestSpans)) {
      if (this.disabled || this.abandoned()) return sent;
      // Past the budget, the rest of the export would be sent to no one waiting for it.
      if (this.clock() >= deadline) {
        if (!this.lastReason) this.lastReason = "export ran out of time before every request was sent";
        return sent;
      }
      const outcome = await this.send(group, deadline);
      if (outcome === "sent") {
        sent += group.length;
        continue;
      }
      if (outcome === "halt") break;
    }
    return sent;
  }

  private async send(spans: EncodedSpan[], deadline: number): Promise<Outcome> {
    const res = await this.deliver(requestBody(spans), deadline);
    if (!res) {
      this.lastCycle = "unreachable";
      return "halt";
    }
    if (res.ok) {
      this.authFailures = 0;
      if (this.debug) {
        const data = await res.json().catch(() => ({}));
        console.log(`[evalkit] exported ${spans.length} span(s) — status: ${(data as { status?: string }).status}`);
      } else {
        // An unread body holds its connection, and one export can make several requests.
        await discardBody(res);
      }
      return "sent";
    }
    const text = await readSnippet(res);
    if (isRetryableStatus(res.status)) {
      this.lastCycle = "unreachable";
      this.lastReason = `export failed ${res.status}: ${text}`;
      return "halt";
    }
    if (res.status === 401 || res.status === 403) {
      // One refusal per export, however many requests it takes: a receiver briefly unable to check keys must
      // not use up the auth-failure limit within one large export.
      this.lastCycle = "auth";
      this.onAuthFailure(res.status, text);
      return "halt";
    }
    if (this.lastCycle === "ok") this.lastCycle = "refused";
    if (res.status === 413) {
      if (spans.length > 1) {
        const half = Math.floor(spans.length / 2);
        const first = await this.send(spans.slice(0, half), deadline);
        if (first === "halt") return first;
        const second = await this.send(spans.slice(half), deadline);
        if (second === "sent" && first === "sent") {
          if (this.lastCycle === "refused") this.lastCycle = "ok";
          return "sent";
        }
        return second === "sent" ? first : second;
      }
      this.reporter.notice(
        `dropping span "${cutReason(spans[0].operation, 80)}" (${spans[0].bytes} bytes): the receiver rejected it ` +
          "as too large (HTTP 413)",
      );
      return "refused";
    }
    this.lastReason = `export failed ${res.status}: ${text}`;
    return "refused";
  }

  private async deliver(body: Buffer, deadline: number): Promise<Response | undefined> {
    if (!this.gzip) return this.post(body, false, deadline);
    let packed: Buffer;
    try {
      packed = await gzipBody(body);
    } catch {
      return this.post(body, false, deadline);
    }
    const compressed = await this.post(packed, true, deadline);
    if (!compressed || (compressed.status !== 400 && compressed.status !== 415)) return compressed;
    // A receiver that predates compressed ingest answers 415, or 400 when it parses the gzip bytes as JSON.
    // The same body sent uncompressed tells that 400 from one about the spans themselves, which the receiver
    // refuses again.
    await discardBody(compressed);
    const plain = await this.post(body, false, deadline);
    if (compressed.status === 415 || plain?.status !== 400) this.stopCompressing(compressed.status);
    return plain;
  }

  private stopCompressing(status: number): void {
    if (!this.gzip) return;
    this.gzip = false;
    sdkLog("warn",
      `[evalkit] the receiver at ${this.url} does not accept gzip-compressed spans (HTTP ${status}); sending ` +
        "them uncompressed from now on. Set EVALKIT_EXPORT_GZIP=false to skip the compressed attempt.",
    );
  }

  private async post(body: Uint8Array, compressed: boolean, deadline: number): Promise<Response | undefined> {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      "X-Subscription-Key": this.subscriptionKey,
    };
    if (compressed) headers["Content-Encoding"] = "gzip";
    try {
      // Buffer.from and zlib return Buffers over a plain ArrayBuffer, the kind fetch's body type asks for.
      return await this.fetchWithRetry(this.url, { method: "POST", headers, body: body as BodyInit }, deadline);
    } catch (err) {
      this.lastReason = `export network error: ${describeNetworkError(err)}`;
      return undefined;
    }
  }

  private onAuthFailure(status: number, text: string): void {
    this.authFailures++;
    this.counters.lastError = cutReason(`export rejected ${status}: ${text}`);
    if (this.authFailures >= AUTH_FAIL_LIMIT) {
      this.disabled = true;
      sdkLog(
        "error",
        `[evalkit] the receiver refused the subscription key (HTTP ${status}) ${this.authFailures} times in a row; ` +
          "tracing is disabled for this process. Check EVALKIT_SUBSCRIPTION_KEY (the key of your trace project).",
      );
    } else if (this.authFailures === 1) {
      sdkLog(
        "error",
        `[evalkit] the receiver refused the subscription key (HTTP ${status}): ${cutReason(text, 120)}. ` +
          `Tracing stops after ${AUTH_FAIL_LIMIT} refusals in a row; check the key passed to init().`,
      );
    } else if (this.debug) {
      sdkLog("warn", `[evalkit] export rejected ${status} (auth failure ${this.authFailures}/${AUTH_FAIL_LIMIT})`);
    }
  }

  // Retries what the receiver could not take now (no answer, 429, 5xx) while the export's budget lasts. A
  // Retry-After on 429 or 503 sets the wait; without one the backoff is jittered.
  private abandoned(): boolean {
    return !!this.cycle?.signal.aborted;
  }

  private async fetchWithRetry(url: string, init: RequestInit, deadline: number, maxRetries = 3): Promise<Response> {
    let lastErr: unknown;
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      if (this.abandoned()) throw this.cycle?.signal.reason ?? new Error("the export was abandoned");
      let wait: number;
      const timeout = Math.min(ATTEMPT_TIMEOUT_MS, Math.max(MIN_ATTEMPT_TIMEOUT_MS, deadline - this.clock()));
      const attemptTimer = attemptSignal(timeout, this.cycle?.signal);
      try {
        const res = await fetch(url, attemptTimer.signal ? { ...init, signal: attemptTimer.signal } : init);

        if (!isRetryableStatus(res.status)) return res;
        this.attemptFailed = true;
        if (attempt === maxRetries) return res;
        const retryAfter = res.status === 429 || res.status === 503 ? res.headers.get("retry-after") : null;
        wait = retryDelayMs(attempt, retryAfter, this.clock());
        if (this.clock() + wait > deadline) return res;
        // An unread body holds its connection for as long as the wait lasts.
        await discardBody(res);
        if (this.debug) console.warn(`[evalkit] HTTP ${res.status}, retry ${attempt + 1}/${maxRetries} in ${wait} ms`);
      } catch (err) {
        lastErr = err;
        this.attemptFailed = true;
        if (attempt === maxRetries || this.abandoned()) break;
        wait = retryDelayMs(attempt, undefined, this.clock());
        if (this.clock() + wait > deadline) break;
        if (this.debug) console.warn(`[evalkit] network error, retry ${attempt + 1}/${maxRetries}: ${describeNetworkError(err)}`);
      } finally {
        attemptTimer.done();
      }
      await this.pause(wait);
    }
    throw lastErr;
  }

  shutdown(): Promise<void> {
    return Promise.resolve();
  }

  private toEnvelope(span: ReadableSpan): TraceEnvelope {
    const ctx = span.spanContext();
    const attrs = span.attributes;
    const startMs = hrTimeToMs(span.startTime);
    const endMs = hrTimeToMs(span.endTime);

    let derivedFrames: { frames?: string; source?: string } | undefined;
    const events: SpanEvent[] = span.events.map((e) => {
      let eventAttributes = e.attributes as Record<string, unknown> | undefined;
      // Another library's exception event is held to the same caps as the SDK's own, and its stack gives
      // the span frames when the span has none.
      if (e.name === EXCEPTION_EVENT && eventAttributes) {
        const normalised = normaliseExceptionEvent(eventAttributes);
        eventAttributes = normalised.attributes;
        if (!derivedFrames && normalised.frames) derivedFrames = normalised;
      }
      return {
        name: e.name,
        timestamp: new Date(hrTimeToMs(e.time)).toISOString(),
        attributes: eventAttributes as Record<string, string | number | boolean>,
      };
    });

    const scope = scopeForSpan(span, ctx.traceId);
    const declaredType = attrs["evalkit.span_type"] as TraceEnvelope["spanType"] | undefined;
    // Another library's span that names a GenAI operation is typed by that operation; what the SDK
    // created itself already says what it is.
    const framework = declaredType === undefined ? frameworkSpanFields(span, COUNT_FOREIGN_LLM) : undefined;
    const agentName = agentNameOf(attrs) ?? framework?.agentName ?? scope.agentName;
    const foreignLlm = framework ? !framework.keepTokens : !COUNT_FOREIGN_LLM && isForeignGenAi(attrs);
    const cacheReadTokens = foreignLlm ? undefined : firstTokenCount(attrs, CACHE_READ_KEYS);
    const cacheCreationTokens = foreignLlm ? undefined : firstTokenCount(attrs, CACHE_CREATION_KEYS);
    const envelope: TraceEnvelope = {
      traceId: ctx.traceId,
      spanId: ctx.spanId,

      parentSpanId: (span as any).parentSpanContext?.spanId ?? (span as any).parentSpanId,
      spanKind: spanKindName(span.kind),
      spanType: declaredType ?? framework?.spanType ?? (foreignLlm ? "function_call" : inferSpanType(span, attrs)),
      status: framework?.status ?? otelStatusToString(span.status.code),
      statusMessage: span.status.message,
      serviceName: this.serviceNameFor(span),
      operation: framework?.operation ?? span.name,
      model: (attrs["gen_ai.response.model"] ?? attrs["gen_ai.request.model"]) as string | undefined,
      provider: (attrs["gen_ai.system"] || attrs["gen_ai.provider.name"]) as string | undefined,
      prompt: (attrs["evalkit.prompt"] as string | undefined) ?? framework?.prompt,
      completion: (attrs["evalkit.completion"] as string | undefined) ?? framework?.completion,
      tokensIn: foreignLlm
        ? undefined
        : foldExclusiveCache(firstTokenCount(attrs, TOKENS_IN_KEYS), cacheReadTokens, cacheCreationTokens),
      tokensOut: foreignLlm ? undefined : firstTokenCount(attrs, TOKENS_OUT_KEYS),

      cacheReadTokens,
      cacheCreationTokens,
      latencyMs: Math.round(endMs - startMs),
      startTime: new Date(startMs).toISOString(),
      endTime: new Date(endMs).toISOString(),
      events: events.length > 0 ? events : undefined,
      attributes: {
        ...framework?.attributes,
        ...buildAttributes(attrs),
        ...agentAttributes(agentName),
        ...(derivedFrames && attrs["evalkit.exception.frames"] === undefined
          ? {
              "evalkit.exception.frames": derivedFrames.frames!,
              ...(derivedFrames.source && attrs["evalkit.exception.source"] === undefined
                ? { "evalkit.exception.source": derivedFrames.source }
                : {}),
            }
          : {}),
      },
      createdAt: new Date(startMs).toISOString(),
      // Every span the process exports belongs to the deployment init() named, model calls and spans of
      // other libraries included, not only the ones opened through the SDK's API.
      environment: (attrs["evalkit.environment"] as string | undefined) ?? this.environment,
      appVersion: (attrs["evalkit.app_version"] as string | undefined) ?? this.appVersion,
      // A span's own attribute, in any spelling, wins: one written by hand with `session.id` (the
      // OpenTelemetry key) has to group into a session exactly like one written through setUser().
      userId: userIdOf(attrs) ?? scope.userId,
      sessionId: sessionIdOf(attrs) ?? scope.sessionId,
      deviceId: (attrs["evalkit.device_id"] as string | undefined) ?? scope.deviceId ?? this.deviceId,
      agentName,
      sdkVersion: (attrs["evalkit.sdk_version"] as string | undefined) ?? evalkitScopeVersion(span),
    };

    const sim = simByTraceId.get(ctx.traceId);
    if (sim) {
      envelope.isSimulation = true;
      envelope.simulationId = sim.simulationId;
      envelope.scenarioId = sim.scenarioId;
      envelope.runId = sim.runId;
    }

    return envelope;
  }
}

const COUNT_FOREIGN_LLM = process.env.EVALKIT_COUNT_FOREIGN_LLM === "1" || process.env.EVALKIT_COUNT_FOREIGN_LLM === "true";

/**
 * Only the spans an app opens by hand are stamped with `evalkit.sdk_version`; the ones the SDK's
 * instrumentation starts (model calls, requested tools) say which release produced them through the
 * tracer's scope version. Spans from other OpenTelemetry libraries keep none.
 */
function evalkitScopeVersion(span: ReadableSpan): string | undefined {
  const scope = (span as any).instrumentationScope ?? (span as any).instrumentationLibrary;
  return scope?.name === "evalkit" && typeof scope.version === "string" ? scope.version : undefined;
}

function isForeignGenAi(attrs: Record<string, unknown>): boolean {
  if (attrs["evalkit.span_type"] !== undefined) return false;
  return attrs["gen_ai.system"] !== undefined
      || attrs["gen_ai.provider.name"] !== undefined
      || attrs["gen_ai.usage.input_tokens"] !== undefined
      || attrs["gen_ai.usage.output_tokens"] !== undefined
      || attrs["gen_ai.usage.prompt_tokens"] !== undefined
      || attrs["gen_ai.usage.completion_tokens"] !== undefined
      || attrs["gen_ai.operation.name"] !== undefined
      || attrs["gen_ai.request.model"] !== undefined
      || attrs["gen_ai.response.model"] !== undefined;
}

function inferSpanType(span: ReadableSpan, attrs: Record<string, unknown>): TraceEnvelope["spanType"] {
  if (attrs["gen_ai.system"] || attrs["gen_ai.provider.name"] || attrs["gen_ai.request.model"] || attrs["gen_ai.response.model"]) return "llm_call";
  if (attrs["db.system"] || attrs["db.statement"] || attrs["db.operation"] || attrs["db.mongodb.collection"]) return "db_query";
  if (attrs["http.method"] || attrs["http.request.method"] || attrs["url.full"] || attrs["http.url"]) return "http_call";
  const scope = String((span as any).instrumentationScope?.name ?? (span as any).instrumentationLibrary?.name ?? "").toLowerCase();
  if (/prisma|mongo|redis|mysql|postgres|\bpg\b|sql|cassandra|dynamo/.test(scope)) return "db_query";
  if (/http|fetch|undici|axios|grpc|got|request/.test(scope)) return "http_call";
  return "log";
}

function encodeEnvelope(env: TraceEnvelope, debug: boolean): EncodedSpan | null {
  let json: string | undefined;
  try {
    json = JSON.stringify(env);
  } catch {
    json = undefined;
  }
  let bytes = json === undefined ? Infinity : utf8Length(json);
  if (bytes > MAX_SPAN_BYTES) {
    const fitted = fitEnvelope(env, debug);
    if (!fitted) return null;
    try {
      json = JSON.stringify(fitted);
    } catch {
      return null;
    }
    bytes = utf8Length(json);
  }
  return { json: json!, bytes, operation: env.operation ?? env.spanType };
}

/** Splits spans, in order, into request bodies of at most `maxSpans` spans and `maxBytes` of JSON. A span
 * larger than `maxBytes` on its own travels alone. */
function groupForRequests(spans: EncodedSpan[], maxBytes: number, maxSpans: number): EncodedSpan[][] {
  const groups: EncodedSpan[][] = [];
  let current: EncodedSpan[] = [];
  let size = BODY_OVERHEAD;
  for (const span of spans) {
    if (current.length > 0 && (current.length >= maxSpans || size + 1 + span.bytes > maxBytes)) {
      groups.push(current);
      current = [];
      size = BODY_OVERHEAD;
    }
    size += span.bytes + (current.length > 0 ? 1 : 0);
    current.push(span);
  }
  if (current.length > 0) groups.push(current);
  return groups;
}

function requestBody(spans: EncodedSpan[]): Buffer {
  return Buffer.from(`{"events":[${spans.map((s) => s.json).join(",")}]}`, "utf8");
}

async function discardBody(res: Response): Promise<void> {
  try {
    await res.text();
  } catch {

  }
}

const BODY_ATTRIBUTES = ["http.response.body", "http.request.body", "gen_ai.response.body", "gen_ai.request.body", "response.body", "request.body"];

function fitEnvelope(env: TraceEnvelope, debug: boolean): TraceEnvelope | null {
  const size = (e: TraceEnvelope): number => {
    try { return utf8Length(JSON.stringify(e)); } catch { return Infinity; }
  };
  if (size(env) <= MAX_SPAN_BYTES) return env;

  const attrs = env.attributes as Record<string, unknown> | undefined;
  // Bodies share what is left of the span's room, each keeping its start and its end.
  if (attrs) {
    const share = Math.floor(MAX_SPAN_BYTES / (BODY_ATTRIBUTES.length + 2));
    for (const k of BODY_ATTRIBUTES) {
      const v = attrs[k];
      if (typeof v !== "string") continue;
      const cut = cutMiddle(v, share);
      if (!cut) continue;
      attrs[k] = cut.value;
      if (attrs[TRUNCATED_PREFIX + k] === undefined) attrs[TRUNCATED_PREFIX + k] = cut.originalBytes;
    }
  }
  if (size(env) <= MAX_SPAN_BYTES) return env;

  const note = (n: number): string => `…[dropped ${n} bytes — exceeded trace span size limit]`;
  if (attrs) {
    for (const k of BODY_ATTRIBUTES) {
      const v = attrs[k];
      if (typeof v === "string" && v.length > 1024) attrs[k] = note(utf8Length(v));
    }
  }
  if (size(env) <= MAX_SPAN_BYTES) return env;

  if (env.prompt && env.prompt.length > 1024) env.prompt = note(utf8Length(env.prompt));
  if (env.completion && env.completion.length > 1024) env.completion = note(utf8Length(env.completion));
  if (env.statusMessage && env.statusMessage.length > 4096) env.statusMessage = env.statusMessage.slice(0, 4096);
  if (size(env) <= MAX_SPAN_BYTES) return env;

  if (attrs) {
    for (const [k, v] of Object.entries(attrs)) {
      if (typeof v === "string" && v.length > 512) attrs[k] = v.slice(0, 512) + "…";
    }
  }
  if (size(env) <= MAX_SPAN_BYTES) return env;

  env.attributes = { "trace.truncated": true };
  env.events = undefined;
  env.prompt = undefined;
  env.completion = undefined;
  if (size(env) <= MAX_SPAN_BYTES) return env;

  if (debug) console.warn(`[evalkit] dropping oversized span "${env.operation}" (${size(env)}B > ${MAX_SPAN_BYTES}B)`);
  return null;
}

function hrTimeToMs(hrTime: [number, number]): number {
  return hrTime[0] * 1000 + hrTime[1] / 1e6;
}

function spanKindName(kind: number): TraceEnvelope["spanKind"] {
  const map: Record<number, TraceEnvelope["spanKind"]> = {
    0: "INTERNAL",
    1: "SERVER",
    2: "CLIENT",
    3: "PRODUCER",
    4: "CONSUMER",
  };
  return map[kind] ?? "INTERNAL";
}

function otelStatusToString(code: number): TraceEnvelope["status"] {
  if (code === 1) return "OK";
  if (code === 2) return "ERROR";
  return "UNSET";
}

/**
 * The span's attributes for the envelope, each string within the per-value limit. The SDK's own spans are
 * cut as they are set; this holds spans of other libraries to the same limit, on the copy that is sent.
 */
function buildAttributes(
  attrs: ReadableSpan["attributes"]
): Record<string, string | number | boolean | string[]> {
  const out: Record<string, string | number | boolean | string[]> = {};
  const limit = valueLimitBytes();
  for (const [k, v] of Object.entries(attrs)) {
    if (PROMOTED_ATTRIBUTES.has(k)) continue;
    if (v === undefined || v === null) continue;
    if (typeof v === "string") {
      const cut = cutMiddle(v, limit);
      if (cut) {
        out[k] = cut.value;
        if (attrs[TRUNCATED_PREFIX + k] === undefined) out[TRUNCATED_PREFIX + k] = cut.originalBytes;
        continue;
      }
    }
    out[k] = v as string | number | boolean | string[];
  }
  return out;
}

async function readSnippet(res: Response): Promise<string> {
  try {
    const text = await res.text();
    return cutReason(text || "(no body)", 100);
  } catch {
    return "(no body)";
  }
}

function describeNetworkError(err: unknown): string {
  try {
    const e = err as { name?: unknown; message?: unknown; cause?: { code?: unknown; message?: unknown } } | undefined;
    if (e?.name === "TimeoutError" || e?.name === "AbortError") return "no answer before the attempt timed out";
    const cause = e?.cause?.code ?? e?.cause?.message;
    const head = `${typeof e?.name === "string" ? e.name : "Error"}: ${typeof e?.message === "string" ? e.message : String(err)}`;
    return cutReason(cause ? `${head} (${String(cause)})` : head, 150);
  } catch {
    return "network error";
  }
}

// A wait between attempts never keeps the process alive on its own (a flush the app awaits holds it for
// its own timeout), and it ends at once when the export is abandoned.
function sleep(ms: number, abandon?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (abandon?.aborted) {
      resolve();
      return;
    }
    const done = (): void => {
      clearTimeout(timer);
      abandon?.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    (timer as { unref?: () => void }).unref?.();
    abandon?.addEventListener("abort", done, { once: true });
  });
}
