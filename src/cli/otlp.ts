const MAX_ATTR = 4096;

export interface OtlpAttribute {
  key: string;
  value: Record<string, unknown>;
}

export function attr(key: string, value: unknown): OtlpAttribute {
  if (typeof value === "boolean") return { key, value: { boolValue: value } };
  if (typeof value === "bigint") return { key, value: { intValue: value.toString() } };
  if (typeof value === "number") return Number.isInteger(value) ? { key, value: { intValue: String(value) } } : { key, value: { doubleValue: value } };
  if (typeof value === "string") return { key, value: { stringValue: value.slice(0, MAX_ATTR) } };
  return { key, value: { stringValue: JSON.stringify(value).slice(0, MAX_ATTR) } };
}

export interface LogRecordOptions {
  body?: string;
  prefix?: string;
  trace?: string;
  span?: string;
}

export function logRecord(vendor: string, event: string, attributes: OtlpAttribute[], options: LogRecordOptions = {}): Record<string, unknown> {
  const now = (BigInt(Date.now()) * 1_000_000n).toString();
  const name = `${options.prefix ?? vendor}.${event}`;
  const record: Record<string, unknown> = {
    timeUnixNano: now,
    observedTimeUnixNano: now,
    severityText: "INFO",
    body: { stringValue: options.body ?? name },
    attributes: [attr("event.name", name), ...attributes],
  };
  if (options.trace) record.traceId = options.trace;
  if (options.span) record.spanId = options.span;
  return {
    resourceLogs: [
      {
        resource: { attributes: [attr("service.name", vendor), attr("agent.vendor", vendor), attr("telemetry.sdk.name", "evalkit-cli")] },
        scopeLogs: [{ scope: { name: "evalkit-cli" }, logRecords: [record] }],
      },
    ],
  };
}

export interface SendResult {
  status: number | null;
  error: string | null;
}

export async function send(endpoint: string, key: string, signal: string, record: Record<string, unknown>, timeoutMs = 4000): Promise<SendResult> {
  try {
    const res = await fetch(`${baseUrl(endpoint)}/v1/${signal}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
      body: JSON.stringify(record),
      signal: AbortSignal.timeout(timeoutMs),
    });
    return { status: res.status, error: res.ok ? null : res.statusText };
  } catch (error) {
    return { status: null, error: (error as Error).message };
  }
}

export function sendLogs(endpoint: string, key: string, record: Record<string, unknown>, timeoutMs = 4000): Promise<SendResult> {
  return send(endpoint, key, "logs", record, timeoutMs);
}

export function sendTraces(endpoint: string, key: string, record: Record<string, unknown>, timeoutMs = 4000): Promise<SendResult> {
  return send(endpoint, key, "traces", record, timeoutMs);
}

export interface FetchResult {
  status: number | null;
  body: unknown;
  error: string | null;
}

export async function getJson(url: string, key: string, timeoutMs = 8000): Promise<FetchResult> {
  try {
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${key}`, Accept: "application/json" },
      signal: AbortSignal.timeout(timeoutMs),
    });
    const text = await res.text();
    if (!res.ok) return { status: res.status, body: null, error: res.statusText };
    try {
      return { status: res.status, body: JSON.parse(text || "{}"), error: null };
    } catch {
      return { status: res.status, body: null, error: "response was not JSON" };
    }
  } catch (error) {
    return { status: null, body: null, error: (error as Error).message };
  }
}

export function baseUrl(endpoint: string): string {
  return endpoint.endsWith("/") ? endpoint.slice(0, -1) : endpoint;
}

export function readBase(endpoint: string): string {
  const base = baseUrl(endpoint);
  for (const suffix of ["/v1/otlp", "/otlp"]) {
    if (base.endsWith(suffix)) return base.slice(0, -suffix.length);
  }
  return base;
}
