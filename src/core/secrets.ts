import type { TraceEnvelope } from "./types.js";
import { MASK, SENSITIVE_HEADER_RE } from "../utils/headers.js";

export const SECRET_KEY_RE =
  /(?:^|[._-])(api[_-]?key|apikey|secret|password|passwd|authorization|credentials?|subscription[_-]?key|x-subscription-key|cookie|set-cookie|private[_-]?key|access[_-]?key|client[_-]?secret)(?:$|[._-])/i;

export const SECRET_TOKEN_KEY_RE = /(?:^|[._-])token$/i;

// Keys that end in "token" because they measure or price tokens rather than hold
// one: OpenTelemetry's gen_ai.server.time_to_first_token and
// gen_ai.server.time_per_output_token on bridged spans, and per-token prices such
// as input_cost_per_token or input_cost_per_audio_token. A price says so before
// "per" (cost_per_..., price_per_...); a bare "per" is followed only by the kinds
// of token a model is billed for, so per_user_token, which could hold a
// credential, is still masked. Masking these blanks out time-to-first-token and
// cost and protects nothing.
export const TELEMETRY_TOKEN_KEY_RE =
  /(?:^|[._-])(?:to[._-]first|(?:cost|price)[._-]per(?:[._-][a-z0-9]+)*|per(?:[._-](?:input|output|prompt|completion|generated|audio|text|image|video|cached|cache|read|write|creation|reasoning|thinking|tool|character))*)[._-]token$/i;

export const SECRET_QUERY_KEY_RE = /(?:^|[._-])(key|sig|signature)$/i;

// The vocabulary of an assignment such as api_key='...' or password: "...", searched for by the word itself
// so that scanning a long payload costs one pass; the full name is read back from the text before the match
// and decided by isSecretKey, so tokens= and max_tokens: stay untouched.
const ASSIGNED_SECRET_RE =
  /(key|secret|passw(?:or)?d|token|credentials?|authorization|cookie)(['"]?)\s*[=:]\s*(['"])((?:[^'"\\\n]|\\.){1,1024})\3/gi;

const NAME_CHAR_RE = /[A-Za-z0-9_.-]/;

function maskAssignedSecret(match: string, word: string, _nameQuote: string, quote: string, value: string, offset: number, text: string): string {
  let begin = offset;
  while (begin > 0 && offset - begin < 64 && NAME_CHAR_RE.test(text[begin - 1])) begin--;
  if (!isSecretKey(text.slice(begin, offset) + word)) return match;
  return match.slice(0, match.length - value.length - quote.length) + MASK + quote;
}

type Replacement = string | ((match: string, ...groups: any[]) => string);

export const SECRET_PATTERNS: ReadonlyArray<readonly [RegExp, Replacement]> = [
  // A whole PEM private key, or what is left of one when the text was cut inside it.
  [/-----BEGIN[A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END[A-Z ]*PRIVATE KEY-----|$)/g, MASK],
  [/tk_live_[0-9a-f]{8,}/g, `tk_live_${MASK}`],
  [/tk_test_[0-9a-f]{8,}/g, `tk_test_${MASK}`],
  [/sk-[A-Za-z0-9_-]{16,}/g, `sk-${MASK}`],
  // A JSON Web Token: three base64url segments, the first two encoding JSON objects.
  [/eyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, MASK],
  [/(Bearer)\s+[A-Za-z0-9._~+/=-]{8,}/gi, `$1 ${MASK}`],
  [/AKIA[0-9A-Z]{16}/g, `AKIA${MASK}`],
  [/ghp_[A-Za-z0-9]{20,}/g, `ghp_${MASK}`],
  // Google API keys (Gemini, Maps, Firebase).
  [/AIza[0-9A-Za-z_-]{30,}/g, `AIza${MASK}`],
  // The userinfo of a URL or DSN written into text: postgres://user:pass@host, https://key@host.
  [/\b([A-Za-z][A-Za-z0-9+.-]{1,30}:\/\/)[^\s/?#@'"<>\\]+@/g, `$1${MASK}@`],
  [ASSIGNED_SECRET_RE, maskAssignedSecret],
];

/**
 * The start of a string member of JSON text, `"name": "`, or of JSON held inside a JSON string,
 * `\"name\": \"`. Only the start is matched, so a member nested in another member's value is still found,
 * and so is one whose value a cut left unterminated.
 */
const MEMBER_HEAD = /(\\*")([A-Za-z0-9_.-]{1,64})\1\s*:\s*\1/g;

/**
 * Where a JSON string value that opened at `from` closes, at the nesting `level` given by the backslashes
 * before its quote: the first quote whose run of backslashes, taken modulo 2 * (level + 1), equals `level`.
 * A quote with more backslashes belongs to the value. The text's length when the value never closes.
 */
function valueEnd(text: string, from: number, level: number): number {
  for (let at = text.indexOf('"', from); at >= 0; at = text.indexOf('"', at + 1)) {
    let run = 0;
    while (at - run - 1 >= from && text[at - run - 1] === "\\") run++;
    if (run % (2 * (level + 1)) === level) return at - level;
  }
  return text.length;
}

/** Masks the value of every string member whose name is a secret's, including one a cut left open. */
function scrubMembers(text: string): string {
  if (!text.includes('"')) return text;
  let out = "";
  let from = 0;
  MEMBER_HEAD.lastIndex = 0;
  for (let m = MEMBER_HEAD.exec(text); m; m = MEMBER_HEAD.exec(text)) {
    if (!isSecretKey(m[2])) continue;
    const valueStart = m.index + m[0].length;
    const end = valueEnd(text, valueStart, m[1].length - 1);
    out += text.slice(from, valueStart) + MASK;
    from = end;
    MEMBER_HEAD.lastIndex = Math.max(end, valueStart);
  }
  return from === 0 ? text : out + text.slice(from);
}

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

/** An error's message and stack, wherever the exception contract records them. */
export const ERROR_MESSAGE_ATTRIBUTES: ReadonlySet<string> = new Set([
  "exception.message",
  "exception.stacktrace",
  "error.message",
  "error.stack",
  "evalkit.exception.causes",
]);

/** An error message or stack with its secrets scrubbed, the query strings of URLs inside it included. */
export function scrubErrorMessage(value: string): string {
  return scrubEmbeddedQueries(scrubString(value));
}

const URL_RE = /^(?:https?|wss?):\/\/\S+$/i;

const MAX_DEPTH = 12;

const CAMEL_BOUNDARY_RE = /(?<=[a-z0-9])(?=[A-Z])/g;

// The first word of a camelCase flag about a token (hasToken, isTokenValid, needsToken): it holds a yes or no.
const FLAG_WORDS: ReadonlySet<string> = new Set([
  "has", "is", "needs", "requires", "uses", "use", "with", "no", "supports", "missing",
]);

function isSecretSpelling(key: string): boolean {
  if (SECRET_KEY_RE.test(key)) return true;
  return SECRET_TOKEN_KEY_RE.test(key) && !TELEMETRY_TOKEN_KEY_RE.test(key);
}

/**
 * Whether a span attribute, payload member or query key names a credential. A camelCase or PascalCase key
 * (accessToken, secretKey, ClientSecret) is split at its capitals and matched by segment as its snake_case
 * spelling is, so a JavaScript object's own keys are masked as a Python payload's are; the Python SDK applies
 * the same rule, and one key masks the same way from either SDK. Counts and prices keep their values
 * (maxTokens, inputCostPerAudioToken, timeToFirstToken), and so does a flag about a token (hasToken).
 */
export function isSecretKey(key: string, headerLike = false): boolean {
  if (isSecretSpelling(key)) return true;
  const split = key.replace(CAMEL_BOUNDARY_RE, "_");
  if (split !== key) {
    if (SECRET_KEY_RE.test(split)) return true;
    if (
      SECRET_TOKEN_KEY_RE.test(split) &&
      !TELEMETRY_TOKEN_KEY_RE.test(split) &&
      !FLAG_WORDS.has(split.split("_", 1)[0].toLowerCase())
    ) {
      return true;
    }
  }
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

// A URL written into an error's message with a query: its credential-named parameters are masked as they are
// in a URL attribute, so `GET https://api.example.com/v1?api_key=...: 401` keeps only the parameter's name.
// Only error messages are read this way: other free text (a prompt, a log line) keeps the URLs it quotes.
const EMBEDDED_URL_QUERY_RE = /\b((?:https?|wss?):\/\/[^\s?#'"<>]*)\?([^\s#'"<>]+)/gi;
const TRAILING_PUNCTUATION_RE = /[.,;:!)\]]+$/;

function scrubEmbeddedQueries(text: string): string {
  if (!text.includes("://") || !text.includes("?")) return text;
  return text.replace(EMBEDDED_URL_QUERY_RE, (_match: string, base: string, query: string) => {
    const trail = TRAILING_PUNCTUATION_RE.exec(query)?.[0] ?? "";
    const params = trail ? query.slice(0, -trail.length) : query;
    return `${base}?${scrubQuery(params)}${trail}`;
  });
}

export function scrubString(value: string): string {
  let out = scrubMembers(value);
  for (const [pattern, replacement] of SECRET_PATTERNS) {
    out = out.replace(pattern, replacement as string);
  }
  return out;
}

// Words that make a parameter or function name a credential's wherever they stand in it: a parameter is a
// single variable, so key, auth or dsn in its name is enough to withhold its value.
const SECRET_NAME_WORDS: ReadonlySet<string> = new Set([
  "key", "keys", "apikey", "secret", "secrets", "password", "passwords", "passwd", "pwd", "passphrase",
  "credential", "credentials", "creds", "auth", "oauth", "authorization", "authenticate",
  "authentication", "cookie", "cookies", "bearer", "jwt", "dsn",
]);

const NAME_WORD_RE = /[a-z]+|[A-Z][a-z]*|[0-9]+/g;

/**
 * Whether a parameter, option or function name says its value is a credential. Broader than isSecretKey,
 * which decides span attribute and payload keys: a parameter named key, auth or dsn holds nothing else,
 * while a payload member named key often does.
 */
export function isSecretName(name: string): boolean {
  if (!name) return false;
  if (isSecretKey(name)) return true;
  return (name.match(NAME_WORD_RE) ?? []).some((word) => SECRET_NAME_WORDS.has(word.toLowerCase()));
}

/**
 * The JSON of a value the app passed or returned, with every member named like a secret masked and every
 * string scrubbed while the value is still whole: once JSON is cut to a length it no longer parses, and a
 * secret could then be found only by its shape.
 */
export function scrubbedJson(value: unknown): string | undefined {
  return JSON.stringify(value, (key: string, item: unknown) => {
    if (key !== "" && isSecretKey(key)) return MASK;
    return typeof item === "string" ? scrubValue(item) : item;
  });
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
    if (ERROR_MESSAGE_ATTRIBUTES.has(key)) {
      const scrubbed = scrubValue(value);
      return scrubEmbeddedQueries(typeof scrubbed === "string" ? scrubbed : value);
    }
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
  if (typeof envelope.statusMessage === "string") envelope.statusMessage = scrubErrorMessage(envelope.statusMessage);
  scrubAttributes(envelope.attributes as Record<string, unknown> | undefined);
  for (const event of envelope.events ?? []) {
    scrubAttributes(event.attributes as Record<string, unknown> | undefined);
  }
  return envelope;
}
