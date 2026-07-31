import type { ReadableSpan, SpanExporter } from "@opentelemetry/sdk-trace-base";
import { ExportResultCode } from "@opentelemetry/core";
import type { ExportResult } from "@opentelemetry/core";
import type { TraceEnvelope, SpanEvent, BatchIngestRequest } from "./types.js";
import { simByTraceId } from "./simulation.js";

// After this many consecutive auth failures (401/403) the exporter disables
// itself. An invalid subscription key never becomes valid by retrying, so
// hammering the ingest endpoint on every flush just spams logs and CPU.
const AUTH_FAIL_LIMIT = 3;

// Hard ceiling on a single span's serialized size. Kept under the Kafka
// broker's message.max.bytes (raised to 10 MiB alongside this — see
// trace-service's KAFKA_MAX_MESSAGE_BYTES and the broker's docker-compose
// config, which must stay >= this value). An oversized span (e.g. a captured
// base64 image body) is trimmed — and dropped if still too big — instead of
// being sent and rejected with "Message Size Too Large". Tracing must never
// ship a payload the backend can't accept.
const MAX_SPAN_BYTES = 8 * 1024 * 1024;

export class EvalKitExporter implements SpanExporter {
  private readonly url: string;
  private readonly subscriptionKey: string;
  private readonly debug: boolean;
  private authFailures = 0;
  private disabled = false;

  constructor(opts: { baseUrl: string; subscriptionKey: string; debug?: boolean }) {
    this.url = `${opts.baseUrl.replace(/\/$/, "")}/v1/ingest`;
    this.subscriptionKey = opts.subscriptionKey;
    this.debug = opts.debug ?? false;
  }

  export(spans: ReadableSpan[], resultCallback: (result: ExportResult) => void): void {
    if (this.disabled) {
      resultCallback({ code: ExportResultCode.FAILED });
      return;
    }

    // Google ADK — both google-adk (Python) and @google/adk (JS, adk-js's
    // core/src/telemetry/tracing.ts) — creates its OWN OpenTelemetry tracer via
    // trace.getTracer('gcp.vertex.agent', ...). The instant EvalKitClient's
    // constructor registers this NodeTracerProvider as the global provider
    // (provider.register(), above in client.ts), every span ADK creates
    // (invoke_agent, execute_tool, the merged-tool-calls span, call_llm, ...)
    // gets swept up here too, duplicating what EvalKit's own hand-rolled
    // google-adk.ts instrumentation already captures cleanly (run_agent /
    // tool_call spans with real function.args/function.result /
    // gen_ai.tool.call.arguments/result) — and rendering as near-empty spans
    // in the dashboard since this generic bridge doesn't know ADK's attribute
    // shapes. Not every ADK span carries the same attributes (e.g. the merged
    // tool-call span sets tool_call_args to the literal string "N/A"), so the
    // reliable signal is the producing tracer's instrumentation scope name —
    // set once, uniformly, for every span that tracer creates — rather than
    // any individual attribute key. EvalKit's hand-rolled spans are
    // authoritative for ADK coverage.
    const nonAdkSpans = spans.filter((s) => {
      const scope = (s as any).instrumentationScope?.name ?? (s as any).instrumentationLibrary?.name;
      return scope !== "gcp.vertex.agent";
    });

    // Bound every span to the backend's message-size limit. Oversized spans are
    // trimmed (heavy bodies → prompt/completion → attrs) and, only if still too
    // big, dropped entirely — so a huge span can never break or stall ingest.
    const events = nonAdkSpans
      .map((s) => fitEnvelope(this.toEnvelope(s), this.debug))
      .filter((e): e is TraceEnvelope => e !== null);

    if (events.length === 0) {
      resultCallback({ code: ExportResultCode.SUCCESS });
      return;
    }

    const body: BatchIngestRequest = { events };

    if (this.debug) {
      console.log(`[evalkit] sending ${events.length} span(s) → ${this.url}`);
    }

    this.fetchWithRetry(this.url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Subscription-Key": this.subscriptionKey,
      },
      body: JSON.stringify(body),
    })
      .then(async (res) => {
        if (!res.ok) {
          const text = await res.text().catch(() => "(no body)");
          if (res.status === 401 || res.status === 403) {
            this.authFailures++;
            if (this.authFailures >= AUTH_FAIL_LIMIT) {
              this.disabled = true;
              console.error(
                `[evalkit] export rejected ${res.status}: ${text} — disabling tracing after ` +
                `${this.authFailures} consecutive auth failures; check your EvalKit subscription key.`,
              );
            } else if (this.debug) {
              console.warn(`[evalkit] export rejected ${res.status} (auth failure ${this.authFailures}/${AUTH_FAIL_LIMIT})`);
            }
          } else {
            console.error(`[evalkit] export failed ${res.status}: ${text}`);
          }
          resultCallback({ code: ExportResultCode.FAILED });
          return;
        }
        this.authFailures = 0; // success resets the auth-failure streak
        if (this.debug) {
          const data = await res.json().catch(() => ({}));
          console.log(`[evalkit] exported ${events.length} span(s) — status: ${(data as { status?: string }).status}`);
        }
        resultCallback({ code: ExportResultCode.SUCCESS });
      })
      .catch((err) => {
        console.error("[evalkit] export network error:", err);
        resultCallback({ code: ExportResultCode.FAILED });
      });
  }

  private async fetchWithRetry(url: string, init: RequestInit, maxRetries = 3): Promise<Response> {
    const delays = [200, 600, 1800];
    let lastErr: unknown;
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        const res = await fetch(url, init);
        // Don't retry 4xx — those are caller errors (auth, validation)
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

    const foreignLlm = !COUNT_FOREIGN_LLM && isForeignGenAi(attrs);
    const envelope: TraceEnvelope = {
      traceId: ctx.traceId,
      spanId: ctx.spanId,
      // OTel renamed this: newer sdk-trace-base exposes parentSpanContext.spanId,
      // older exposes parentSpanId. Read whichever exists (cast — type varies by version).
      parentSpanId: (span as any).parentSpanContext?.spanId ?? (span as any).parentSpanId,
      spanKind: spanKindName(span.kind),
      spanType: (attrs["evalkit.span_type"] as TraceEnvelope["spanType"]) ?? (foreignLlm ? "function_call" : inferSpanType(span, attrs)),
      status: otelStatusToString(span.status.code),
      statusMessage: span.status.message,
      serviceName: span.resource.attributes["service.name"] as string | undefined,
      operation: span.name,
      model: (attrs["gen_ai.response.model"] ?? attrs["gen_ai.request.model"]) as string | undefined,
      provider: attrs["gen_ai.system"] as string | undefined,
      prompt: attrs["evalkit.prompt"] as string | undefined,
      completion: attrs["evalkit.completion"] as string | undefined,
      tokensIn: foreignLlm ? undefined : (Math.round((attrs["gen_ai.usage.input_tokens"] as number) || 0) || undefined),
      tokensOut: foreignLlm ? undefined : (Math.round((attrs["gen_ai.usage.output_tokens"] as number) || 0) || undefined),
      // Gemini/Vertex instrumentation only has one cache concept and stashes
      // it under `gen_ai.usage.cached_tokens` (no separate read/write like
      // Anthropic) — fall back to that when the Anthropic/OpenAI-style key
      // isn't present.
      cacheReadTokens: foreignLlm ? undefined : (Math.round(((attrs["gen_ai.usage.cache_read_tokens"] ?? attrs["gen_ai.usage.cached_tokens"]) as number) || 0) || undefined),
      cacheCreationTokens: foreignLlm ? undefined : (Math.round((attrs["gen_ai.usage.cache_creation_tokens"] as number) || 0) || undefined),
      latencyMs: Math.round(endMs - startMs),
      startTime: new Date(startMs).toISOString(),
      endTime: new Date(endMs).toISOString(),
      events: events.length > 0 ? events : undefined,
      attributes: buildAttributes(attrs),
      createdAt: new Date(startMs).toISOString(),
      environment: attrs["evalkit.environment"] as string | undefined,
      appVersion: attrs["evalkit.app_version"] as string | undefined,
      userId: attrs["evalkit.user_id"] as string | undefined,
      sessionId: attrs["evalkit.session_id"] as string | undefined,
      deviceId: attrs["evalkit.device_id"] as string | undefined,
      sdkVersion: attrs["evalkit.sdk_version"] as string | undefined,
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

// Opt-out: EVALKIT_COUNT_FOREIGN_LLM=1 keeps foreign OTel gen_ai spans as cost-bearing.
const COUNT_FOREIGN_LLM = process.env.EVALKIT_COUNT_FOREIGN_LLM === "1" || process.env.EVALKIT_COUNT_FOREIGN_LLM === "true";

// A foreign/bridged OTel GenAI span (framework or community instrumentation) carries
// gen_ai.* but no evalkit.span_type. EvalKit's own native llm_call span is the single
// source of cost truth, so foreign ones are downgraded to function_call with tokens dropped.
function isForeignGenAi(attrs: Record<string, unknown>): boolean {
  if (attrs["evalkit.span_type"] !== undefined) return false;
  return attrs["gen_ai.system"] !== undefined
      || attrs["gen_ai.usage.input_tokens"] !== undefined
      || attrs["gen_ai.usage.output_tokens"] !== undefined
      || attrs["gen_ai.operation.name"] !== undefined
      || attrs["gen_ai.request.model"] !== undefined;
}

// Categorize spans from third-party OpenTelemetry instrumentations (Prisma,
// mongodb, ioredis, http…) that don't carry our `evalkit.span_type`. Lets a
// single init() pick up the whole OTel ecosystem with sensible types.
function inferSpanType(span: ReadableSpan, attrs: Record<string, unknown>): TraceEnvelope["spanType"] {
  if (attrs["db.system"] || attrs["db.statement"] || attrs["db.operation"] || attrs["db.mongodb.collection"]) return "db_query";
  if (attrs["http.method"] || attrs["http.request.method"] || attrs["url.full"] || attrs["http.url"]) return "http_call";
  const scope = String((span as any).instrumentationScope?.name ?? (span as any).instrumentationLibrary?.name ?? "").toLowerCase();
  if (/prisma|mongo|redis|mysql|postgres|\bpg\b|sql|cassandra|dynamo/.test(scope)) return "db_query";
  if (/http|fetch|undici|axios|grpc|got|request/.test(scope)) return "http_call";
  return "log";
}

// Guarantee a span serializes to <= MAX_SPAN_BYTES so it can always be ingested.
// Drops the heaviest fields first (raw bodies, then prompt/completion, then every
// large string attribute); if the skeleton still won't fit, returns null so the
// caller skips it. Tracing must never send something the backend will reject.
function fitEnvelope(env: TraceEnvelope, debug: boolean): TraceEnvelope | null {
  const size = (e: TraceEnvelope): number => {
    try { return JSON.stringify(e).length; } catch { return Infinity; }
  };
  if (size(env) <= MAX_SPAN_BYTES) return env;

  const note = (n: number): string => `…[dropped ${n} bytes — exceeded trace span size limit]`;
  const attrs = env.attributes as Record<string, unknown> | undefined;

  // 1) Raw HTTP / GenAI bodies — where base64 images & file blobs live.
  if (attrs) {
    for (const k of ["http.response.body", "http.request.body", "gen_ai.response.body", "gen_ai.request.body", "response.body", "request.body"]) {
      const v = attrs[k];
      if (typeof v === "string" && v.length > 1024) attrs[k] = note(v.length);
    }
  }
  if (size(env) <= MAX_SPAN_BYTES) return env;

  // 2) Prompt / completion / status message.
  if (env.prompt && env.prompt.length > 1024) env.prompt = note(env.prompt.length);
  if (env.completion && env.completion.length > 1024) env.completion = note(env.completion.length);
  if (env.statusMessage && env.statusMessage.length > 4096) env.statusMessage = env.statusMessage.slice(0, 4096);
  if (size(env) <= MAX_SPAN_BYTES) return env;

  // 3) Every remaining large string attribute.
  if (attrs) {
    for (const [k, v] of Object.entries(attrs)) {
      if (typeof v === "string" && v.length > 512) attrs[k] = v.slice(0, 512) + "…";
    }
  }
  if (size(env) <= MAX_SPAN_BYTES) return env;

  // 4) Last resort: metadata-only skeleton.
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
    if (k.startsWith("evalkit.") || k === "gen_ai.system") continue;
    if (v !== undefined && v !== null) {
      out[k] = v as string | number | boolean | string[];
    }
  }
  return out;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
