import type { ReadableSpan, SpanExporter } from "@opentelemetry/sdk-trace-base";
import { ExportResultCode } from "@opentelemetry/core";
import type { ExportResult } from "@opentelemetry/core";
import type { TraceEnvelope, SpanEvent, BatchIngestRequest } from "./types.js";
import { simByTraceId } from "./simulation.js";

export class EvalKitExporter implements SpanExporter {
  private readonly url: string;
  private readonly subscriptionKey: string;
  private readonly debug: boolean;

  constructor(opts: { baseUrl: string; subscriptionKey: string; debug?: boolean }) {
    this.url = `${opts.baseUrl.replace(/\/$/, "")}/v1/ingest`;
    this.subscriptionKey = opts.subscriptionKey;
    this.debug = opts.debug ?? false;
  }

  export(spans: ReadableSpan[], resultCallback: (result: ExportResult) => void): void {
    const events = spans.map((s) => this.toEnvelope(s));
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
          console.error(`[evalkit] export failed ${res.status}: ${text}`);
          resultCallback({ code: ExportResultCode.FAILED });
          return;
        }
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

    const envelope: TraceEnvelope = {
      traceId: ctx.traceId,
      spanId: ctx.spanId,
      parentSpanId: span.parentSpanId,
      spanKind: spanKindName(span.kind),
      spanType: (attrs["evalkit.span_type"] as TraceEnvelope["spanType"]) ?? "log",
      status: otelStatusToString(span.status.code),
      statusMessage: span.status.message,
      serviceName: span.resource.attributes["service.name"] as string | undefined,
      operation: span.name,
      model: (attrs["gen_ai.response.model"] ?? attrs["gen_ai.request.model"]) as string | undefined,
      provider: attrs["gen_ai.system"] as string | undefined,
      prompt: attrs["evalkit.prompt"] as string | undefined,
      completion: attrs["evalkit.completion"] as string | undefined,
      tokensIn: Math.round((attrs["gen_ai.usage.input_tokens"] as number) || 0) || undefined,
      tokensOut: Math.round((attrs["gen_ai.usage.output_tokens"] as number) || 0) || undefined,
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
