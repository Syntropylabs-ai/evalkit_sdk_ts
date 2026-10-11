import { promisify } from "node:util";
import { gzip } from "node:zlib";
import type { ReadableSpan, SpanExporter } from "@opentelemetry/sdk-trace-base";
import { ExportResultCode } from "@opentelemetry/core";
import type { ExportResult } from "@opentelemetry/core";
import type { TraceEnvelope, SpanEvent } from "./types.js";
import { simByTraceId } from "./simulation.js";
import { agentAttributes, agentNameOf, scopeForSpan, sessionIdOf, userIdOf } from "./identity.js";
import { frameworkSpanFields } from "./framework-spans.js";
import { applyMask, envFlag, stripContent } from "./redact.js";
import { scrubSecrets } from "./secrets.js";
import type { MaskHook } from "./redact.js";

const AUTH_FAIL_LIMIT = 3;

const MAX_SPAN_BYTES = 8 * 1024 * 1024;

// The most JSON one export request carries, measured before compression. A batch of large spans goes out
// as several requests, so no request comes near the 10 MiB that the proxy in front of the receiver accepts,
// and a refused request costs only its own spans, not the whole batch.
const MAX_REQUEST_BYTES = 4 * 1024 * 1024;

const DEFAULT_MAX_REQUEST_SPANS = 512;

export const EXPORT_GZIP_ENV_VARS = ["EVALKIT_EXPORT_GZIP"] as const;

// zlib's default: close to the ratio of level 9 for a fraction of the CPU time.
const GZIP_LEVEL = 6;

const gzipAsync = promisify(gzip);

const BODY_OVERHEAD = '{"events":[]}'.length;

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
// "halt": no answer, only 5xx ones, or a refused key, so every later request would meet the same failure.
type Outcome = "sent" | "refused" | "halt";

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

export class EvalKitExporter implements SpanExporter {
  private readonly url: string;
  private readonly subscriptionKey: string;
  private readonly serviceName?: string;
  private readonly debug: boolean;
  private readonly captureContent: boolean;
  private readonly captureSecrets: boolean;
  private readonly mask?: MaskHook;
  private readonly maxRequestSpans: number;
  private gzip: boolean;
  private authFailures = 0;
  private disabled = false;

  constructor(opts: {
    baseUrl: string;
    subscriptionKey: string;
    serviceName?: string;
    debug?: boolean;
    captureContent?: boolean;
    captureSecrets?: boolean;
    exportGzip?: boolean;
    maxExportBatchSize?: number;
    mask?: MaskHook;
  }) {
    this.url = `${opts.baseUrl.replace(/\/$/, "")}/v1/ingest`;
    this.subscriptionKey = opts.subscriptionKey;
    this.serviceName = opts.serviceName;
    this.debug = opts.debug ?? false;
    this.captureContent = opts.captureContent ?? true;
    this.captureSecrets = opts.captureSecrets ?? false;
    this.gzip = opts.exportGzip ?? resolveExportGzip();
    const maxSpans = Math.floor(Number(opts.maxExportBatchSize));
    this.maxRequestSpans = maxSpans >= 1 ? maxSpans : DEFAULT_MAX_REQUEST_SPANS;
    this.mask = opts.mask;
  }

  private redact(envelope: TraceEnvelope): TraceEnvelope | null {
    const stripped = this.captureContent ? envelope : stripContent(envelope);
    const scrubbed = this.captureSecrets ? stripped : scrubSecrets(stripped);
    return this.mask ? applyMask(this.mask, scrubbed) : scrubbed;
  }

  private serviceNameFor(span: ReadableSpan): string | undefined {
    const fromResource = span.resource.attributes["service.name"] as string | undefined;
    if (this.serviceName && (!fromResource || fromResource.startsWith("unknown_service"))) {
      return this.serviceName;
    }
    return fromResource;
  }

  export(spans: ReadableSpan[], resultCallback: (result: ExportResult) => void): void {
    if (this.disabled) {
      resultCallback({ code: ExportResultCode.FAILED });
      return;
    }

    const nonAdkSpans = spans.filter((s) => {
      const scope = (s as any).instrumentationScope?.name ?? (s as any).instrumentationLibrary?.name;
      return scope !== "gcp.vertex.agent";
    });

    const encoded = nonAdkSpans
      .map((s) => this.redact(this.toEnvelope(s)))
      .filter((e): e is TraceEnvelope => e !== null)
      .map((e) => encodeEnvelope(e, this.debug))
      .filter((e): e is EncodedSpan => e !== null);

    if (encoded.length === 0) {
      resultCallback({ code: ExportResultCode.SUCCESS });
      return;
    }

    if (this.debug) {
      console.log(`[evalkit] sending ${encoded.length} span(s) → ${this.url}`);
    }

    this.sendAll(encoded).then(
      (ok) => resultCallback({ code: ok ? ExportResultCode.SUCCESS : ExportResultCode.FAILED }),
      (err) => {
        console.error("[evalkit] export error:", err);
        resultCallback({ code: ExportResultCode.FAILED });
      },
    );
  }

  private async sendAll(spans: EncodedSpan[]): Promise<boolean> {
    let ok = true;
    for (const group of groupForRequests(spans, MAX_REQUEST_BYTES, this.maxRequestSpans)) {
      if (this.disabled) return false;
      const outcome = await this.send(group);
      if (outcome === "sent") continue;
      ok = false;
      if (outcome === "halt") break;
    }
    return ok;
  }

  private async send(spans: EncodedSpan[]): Promise<Outcome> {
    const res = await this.deliver(requestBody(spans));
    if (!res) return "halt";
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
    const text = await res.text().catch(() => "(no body)");
    if (res.status >= 500) {
      console.error(`[evalkit] export failed ${res.status}: ${text}`);
      return "halt";
    }
    if (res.status === 401 || res.status === 403) {
      // One refusal per export, however many requests it takes: a receiver briefly unable to check keys must
      // not use up the auth-failure limit within one large export.
      this.onAuthFailure(res.status, text);
      return "halt";
    }
    if (res.status === 413) {
      if (spans.length > 1) {
        const half = Math.floor(spans.length / 2);
        const first = await this.send(spans.slice(0, half));
        if (first === "halt") return first;
        const second = await this.send(spans.slice(half));
        return second === "sent" ? first : second;
      }
      console.warn(
        `[evalkit] dropping span "${spans[0].operation}" (${spans[0].bytes} bytes): the receiver rejected it ` +
          "as too large (HTTP 413)",
      );
      return "refused";
    }
    console.error(`[evalkit] export failed ${res.status}: ${text}`);
    return "refused";
  }

  private async deliver(body: Buffer): Promise<Response | undefined> {
    if (!this.gzip) return this.post(body, false);
    const compressed = await this.post(await gzipAsync(body, { level: GZIP_LEVEL }), true);
    if (!compressed || (compressed.status !== 400 && compressed.status !== 415)) return compressed;
    // A receiver that predates compressed ingest answers 415, or 400 when it parses the gzip bytes as JSON.
    // The same body sent uncompressed tells that 400 from one about the spans themselves, which the receiver
    // refuses again.
    await discardBody(compressed);
    const plain = await this.post(body, false);
    if (compressed.status === 415 || plain?.status !== 400) this.stopCompressing(compressed.status);
    return plain;
  }

  private stopCompressing(status: number): void {
    if (!this.gzip) return;
    this.gzip = false;
    console.warn(
      `[evalkit] the receiver at ${this.url} does not accept gzip-compressed spans (HTTP ${status}); sending ` +
        "them uncompressed from now on. Set EVALKIT_EXPORT_GZIP=false to skip the compressed attempt.",
    );
  }

  private async post(body: Uint8Array, compressed: boolean): Promise<Response | undefined> {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      "X-Subscription-Key": this.subscriptionKey,
    };
    if (compressed) headers["Content-Encoding"] = "gzip";
    try {
      // Buffer.from and zlib return Buffers over a plain ArrayBuffer, the kind fetch's body type asks for.
      return await this.fetchWithRetry(this.url, { method: "POST", headers, body: body as BodyInit });
    } catch (err) {
      console.error("[evalkit] export network error:", err);
      return undefined;
    }
  }

  private onAuthFailure(status: number, text: string): void {
    this.authFailures++;
    if (this.authFailures >= AUTH_FAIL_LIMIT) {
      this.disabled = true;
      console.error(
        `[evalkit] export rejected ${status}: ${text} — disabling tracing after ` +
        `${this.authFailures} consecutive auth failures; check your EvalKit subscription key.`,
      );
    } else if (this.debug) {
      console.warn(`[evalkit] export rejected ${status} (auth failure ${this.authFailures}/${AUTH_FAIL_LIMIT})`);
    }
  }

  private async fetchWithRetry(url: string, init: RequestInit, maxRetries = 3): Promise<Response> {
    const delays = [200, 600, 1800];
    let lastErr: unknown;
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        const res = await fetch(url, init);

        if (res.ok || (res.status >= 400 && res.status < 500)) return res;
        if (attempt < maxRetries) {
          if (this.debug) console.warn(`[evalkit] HTTP ${res.status}, retry ${attempt + 1}/${maxRetries}`);
          await sleep(delays[attempt] ?? 1800);
        } else {
          return res;
        }
      } catch (err) {
        lastErr = err;
        if (attempt < maxRetries) {
          if (this.debug) console.warn(`[evalkit] network error, retry ${attempt + 1}/${maxRetries}:`, err);
          await sleep(delays[attempt] ?? 1800);
        }
      }
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

    const events: SpanEvent[] = span.events.map((e) => ({
      name: e.name,
      timestamp: new Date(hrTimeToMs(e.time)).toISOString(),
      attributes: e.attributes as Record<string, string | number | boolean>,
    }));

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
      attributes: { ...framework?.attributes, ...buildAttributes(attrs), ...agentAttributes(agentName) },
      createdAt: new Date(startMs).toISOString(),
      environment: attrs["evalkit.environment"] as string | undefined,
      appVersion: attrs["evalkit.app_version"] as string | undefined,
      // A span's own attribute, in any spelling, wins: one written by hand with `session.id` (the
      // OpenTelemetry key) has to group into a session exactly like one written through setUser().
      userId: userIdOf(attrs) ?? scope.userId,
      sessionId: sessionIdOf(attrs) ?? scope.sessionId,
      deviceId: (attrs["evalkit.device_id"] as string | undefined) ?? scope.deviceId,
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
  if (json === undefined || json.length > MAX_SPAN_BYTES) {
    const fitted = fitEnvelope(env, debug);
    if (!fitted) return null;
    try {
      json = JSON.stringify(fitted);
    } catch {
      return null;
    }
  }
  return { json, bytes: Buffer.byteLength(json, "utf8"), operation: env.operation ?? env.spanType };
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

function fitEnvelope(env: TraceEnvelope, debug: boolean): TraceEnvelope | null {
  const size = (e: TraceEnvelope): number => {
    try { return JSON.stringify(e).length; } catch { return Infinity; }
  };
  if (size(env) <= MAX_SPAN_BYTES) return env;

  const note = (n: number): string => `…[dropped ${n} bytes — exceeded trace span size limit]`;
  const attrs = env.attributes as Record<string, unknown> | undefined;

  if (attrs) {
    for (const k of ["http.response.body", "http.request.body", "gen_ai.response.body", "gen_ai.request.body", "response.body", "request.body"]) {
      const v = attrs[k];
      if (typeof v === "string" && v.length > 1024) attrs[k] = note(v.length);
    }
  }
  if (size(env) <= MAX_SPAN_BYTES) return env;

  if (env.prompt && env.prompt.length > 1024) env.prompt = note(env.prompt.length);
  if (env.completion && env.completion.length > 1024) env.completion = note(env.completion.length);
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

function buildAttributes(
  attrs: ReadableSpan["attributes"]
): Record<string, string | number | boolean | string[]> {
  const out: Record<string, string | number | boolean | string[]> = {};
  for (const [k, v] of Object.entries(attrs)) {
    if (PROMOTED_ATTRIBUTES.has(k)) continue;
    if (v !== undefined && v !== null) {
      out[k] = v as string | number | boolean | string[];
    }
  }
  return out;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
