import type { EvalKitClient } from "./core/client.js";

export type FeedbackKind = "thumbs" | "rating" | "reward" | "text";

export interface FeedbackOptions {
  traceId: string;
  kind: FeedbackKind;
  value: number | boolean | string;
  comment?: string;
  userId?: string;
  spanId?: string;
  sessionId?: string;
  name?: string;
  apiUrl?: string;
  timeoutMs?: number;
}

export interface FeedbackResult {
  scoreId?: string;
  recorded?: boolean;
  [key: string]: unknown;
}

const KINDS: readonly FeedbackKind[] = ["thumbs", "rating", "reward", "text"];

function normaliseValue(kind: FeedbackKind, value: number | boolean | string): number | string {
  if (kind === "text") {
    if (typeof value !== "string" || value.trim() === "") throw new Error("text feedback needs a non-empty string value");
    return value;
  }
  if (kind === "thumbs") {
    if (typeof value === "boolean") return value ? 1 : 0;
    if (value === "up" || value === "down") return value === "up" ? 1 : 0;
  }
  if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`${kind} feedback needs a numeric value`);
  return value;
}

export async function feedback(client: EvalKitClient, opts: FeedbackOptions): Promise<FeedbackResult> {
  if (!KINDS.includes(opts.kind)) throw new Error(`kind must be one of ${KINDS.join(", ")}`);
  if (!opts.traceId) throw new Error("traceId is required");
  if (typeof fetch === "undefined") throw new Error("[evalkit] global fetch is required (Node 18+)");

  const base = (opts.apiUrl ?? process.env.EVALKIT_API_URL ?? client.options.apiUrl).replace(/\/$/, "");
  const body: Record<string, unknown> = { traceId: opts.traceId, kind: opts.kind, value: normaliseValue(opts.kind, opts.value) };
  if (opts.spanId !== undefined) body.spanId = opts.spanId;
  if (opts.sessionId !== undefined) body.sessionId = opts.sessionId;
  if (opts.comment !== undefined) body.comment = opts.comment;
  if (opts.userId !== undefined) body.userId = opts.userId;
  if (opts.name !== undefined) body.name = opts.name;

  const res = await fetch(base + "/v1/feedback", {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Subscription-Key": client.options.subscriptionKey },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(opts.timeoutMs ?? 30_000),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`feedback failed ${res.status}: ${text}`);
  }
  return (await res.json()) as FeedbackResult;
}

export function reward(
  client: EvalKitClient,
  traceId: string,
  value: number,
  opts: Omit<FeedbackOptions, "traceId" | "kind" | "value"> = {},
): Promise<FeedbackResult> {
  return feedback(client, { ...opts, traceId, kind: "reward", value });
}
