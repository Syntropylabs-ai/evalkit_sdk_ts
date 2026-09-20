import type { TraceEnvelope } from "./types.js";
import { MASK, SENSITIVE_HEADER_RE } from "../utils/headers.js";

export const SECRET_KEY_RE =
  /(?:^|[._-])(api[_-]?key|apikey|secret|password|passwd|authorization|credentials?|subscription[_-]?key|x-subscription-key|cookie|set-cookie|private[_-]?key|access[_-]?key|client[_-]?secret)(?:$|[._-])/i;

export const SECRET_TOKEN_KEY_RE = /(?:^|[._-])token$/i;

export const SECRET_QUERY_KEY_RE = /(?:^|[._-])(key|sig|signature)$/i;

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

export const URL_ATTRIBUTES: ReadonlySet<string> = new Set([
  "http.url",
  "url.full",
  "http.target",
  "server.address",
]);

export const QUERY_ATTRIBUTES: ReadonlySet<string> = new Set(["url.query"]);

const URL_RE = /^(?:https?|wss?):\/\/\S+$/i;

const MAX_DEPTH = 12;

export function isSecretKey(key: string, headerLike = false): boolean {
  if (SECRET_KEY_RE.test(key) || SECRET_TOKEN_KEY_RE.test(key)) return true;
  return headerLike && SENSITIVE_HEADER_RE.test(key);
}

function decodeQueryKey(key: string): string {
  try {
    return decodeURIComponent(key.replace(/\+/g, " "));
  } catch {
    return key;
  }
}

export function isSecretQueryKey(key: string): boolean {
  const decoded = decodeQueryKey(key);
  return isSecretKey(decoded, true) || SECRET_QUERY_KEY_RE.test(decoded);
}

export function isUrl(value: string): boolean {
  return URL_RE.test(value.trim());
}

export function scrubString(value: string): string {
  let out = value;
  for (const [pattern, replacement] of SECRET_PATTERNS) {
    out = out.replace(pattern, replacement);
  }
  return out;
}

export function scrubQuery(query: string): string {
  return query
    .split("&")
    .map((param) => {
      const eq = param.indexOf("=");
      if (eq < 0) return param;
      const key = param.slice(0, eq);
      return isSecretQueryKey(key) ? `${key}=${MASK}` : param;
    })
    .join("&");
}

function scrubUserinfo(value: string): string {
  const scheme = value.indexOf("://");
  if (scheme < 0) return value;
  const start = scheme + 3;
  const slash = value.indexOf("/", start);
  const end = slash < 0 ? value.length : slash;
  const at = value.lastIndexOf("@", end - 1);
  if (at <= start) return value;
  return value.slice(0, start) + MASK + value.slice(at);
}

export function scrubUrl(value: string): string {
  const hash = value.indexOf("#");
  const head = hash < 0 ? value : value.slice(0, hash);
  const fragment = hash < 0 ? "" : value.slice(hash + 1);
  const question = head.indexOf("?");
  const base = question < 0 ? head : head.slice(0, question);
  const query = question < 0 ? "" : head.slice(question + 1);
  const out =
    scrubUserinfo(base) +
    (question < 0 ? "" : `?${scrubQuery(query)}`) +
    (hash < 0 ? "" : `#${scrubQuery(fragment)}`);
  return scrubString(out);
}

function scrubText(value: string): string {
  return isUrl(value) ? scrubUrl(value) : scrubString(value);
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
    return asJson === undefined ? scrubText(value) : asJson;
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

function scrubAttribute(key: string, value: unknown): unknown {
  if (isSecretKey(key)) return MASK;
  if (typeof value === "string") {
    if (URL_ATTRIBUTES.has(key)) return scrubUrl(value);
    if (QUERY_ATTRIBUTES.has(key)) return scrubString(scrubQuery(value));
  }
  return scrubValue(value, HEADER_ATTRIBUTES.has(key));
}

function scrubAttributes(attrs: Record<string, unknown> | undefined): void {
  if (!attrs) return;
  for (const [key, value] of Object.entries(attrs)) {
    attrs[key] = scrubAttribute(key, value);
  }
}

export function scrubSecrets(envelope: TraceEnvelope): TraceEnvelope {
  if (typeof envelope.operation === "string") envelope.operation = scrubString(envelope.operation);
  if (typeof envelope.prompt === "string") envelope.prompt = scrubString(envelope.prompt);
  if (typeof envelope.completion === "string") envelope.completion = scrubString(envelope.completion);
  if (typeof envelope.statusMessage === "string") envelope.statusMessage = scrubString(envelope.statusMessage);
  scrubAttributes(envelope.attributes as Record<string, unknown> | undefined);
  for (const event of envelope.events ?? []) {
    scrubAttributes(event.attributes as Record<string, unknown> | undefined);
  }
  return envelope;
}
