import type { TraceEnvelope } from "./types.js";
import { MASK, SENSITIVE_HEADER_RE } from "../utils/headers.js";

export const SECRET_KEY_RE =
  /(?:^|[._-])(api[_-]?key|apikey|secret|password|passwd|authorization|credentials?|subscription[_-]?key|x-subscription-key|cookie|set-cookie|private[_-]?key|access[_-]?key|client[_-]?secret)(?:$|[._-])/i;

export const SECRET_TOKEN_KEY_RE = /(?:^|[._-])token$/i;

export const SECRET_PATTERNS: ReadonlyArray<readonly [RegExp, string]> = [
  [/tk_live_[0-9a-f]{8,}/g, `tk_live_${MASK}`],
  [/tk_test_[0-9a-f]{8,}/g, `tk_test_${MASK}`],
  [/sk-[A-Za-z0-9_-]{16,}/g, `sk-${MASK}`],
  [/(Bearer)\s+[A-Za-z0-9._~+/=-]{8,}/gi, `$1 ${MASK}`],
  [/AKIA[0-9A-Z]{16}/g, `AKIA${MASK}`],
  [/ghp_[A-Za-z0-9]{20,}/g, `ghp_${MASK}`],
];

export const HEADER_ATTRIBUTES: ReadonlySet<string> = new Set([
  "http.request.headers",
  "http.response.headers",
]);

const MAX_DEPTH = 12;

export function isSecretKey(key: string, headerLike = false): boolean {
  if (SECRET_KEY_RE.test(key) || SECRET_TOKEN_KEY_RE.test(key)) return true;
  return headerLike && SENSITIVE_HEADER_RE.test(key);
}

export function scrubString(value: string): string {
  let out = value;
  for (const [pattern, replacement] of SECRET_PATTERNS) {
    out = out.replace(pattern, replacement);
  }
  return out;
}

function scrubJsonString(value: string, headerLike: boolean, depth: number): string | undefined {
  const trimmed = value.trimStart();
  if (trimmed === "" || (trimmed[0] !== "{" && trimmed[0] !== "[")) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return undefined;
  }
  if (parsed === null || typeof parsed !== "object") return undefined;
  const scrubbed = scrubValue(parsed, headerLike, depth + 1);
  try {
    const after = JSON.stringify(scrubbed);
    return after === JSON.stringify(parsed) ? undefined : after;
  } catch {
    return undefined;
  }
}

export function scrubValue(value: unknown, headerLike = false, depth = 0): unknown {
  if (depth > MAX_DEPTH) return value;
  if (typeof value === "string") {
    const asJson = scrubJsonString(value, headerLike, depth);
    return asJson === undefined ? scrubString(value) : asJson;
  }
  if (Array.isArray(value)) {
    return value.map((item) => scrubValue(item, headerLike, depth + 1));
  }
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      out[key] = isSecretKey(key, headerLike) ? MASK : scrubValue(item, headerLike, depth + 1);
    }
    return out;
  }
  return value;
}

function scrubAttributes(attrs: Record<string, unknown> | undefined): void {
  if (!attrs) return;
  for (const [key, value] of Object.entries(attrs)) {
    attrs[key] = isSecretKey(key) ? MASK : scrubValue(value, HEADER_ATTRIBUTES.has(key));
  }
}

export function scrubSecrets(envelope: TraceEnvelope): TraceEnvelope {
  if (typeof envelope.prompt === "string") envelope.prompt = scrubString(envelope.prompt);
  if (typeof envelope.completion === "string") envelope.completion = scrubString(envelope.completion);
  if (typeof envelope.statusMessage === "string") envelope.statusMessage = scrubString(envelope.statusMessage);
  scrubAttributes(envelope.attributes as Record<string, unknown> | undefined);
  for (const event of envelope.events ?? []) {
    scrubAttributes(event.attributes as Record<string, unknown> | undefined);
  }
  return envelope;
}
