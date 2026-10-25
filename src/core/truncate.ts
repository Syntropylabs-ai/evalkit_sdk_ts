// Sizes here are UTF-8 bytes: what the receiver, and the proxy in front of it, count, and what a value
// costs on the wire. A JavaScript string's length counts UTF-16 units, which undercounts any text that is
// not ASCII.

/** The most one attribute value keeps by default: the most one ingest request may carry through the proxy. */
export const DEFAULT_VALUE_LIMIT_BYTES = 16 * 1024 * 1024;

/** Where a cut value's original size is recorded: `evalkit.truncated.<attribute>` = its UTF-8 byte length. */
export const TRUNCATED_PREFIX = "evalkit.truncated.";

let valueLimit = DEFAULT_VALUE_LIMIT_BYTES;

export function setValueLimitBytes(limit: number): void {
  valueLimit = limit > 0 && Number.isFinite(limit) ? Math.floor(limit) : DEFAULT_VALUE_LIMIT_BYTES;
}

export function valueLimitBytes(): number {
  return valueLimit;
}

/**
 * The per-value limit in force: the option when given, else the default, and never more than
 * OTEL_SPAN_ATTRIBUTE_VALUE_LENGTH_LIMIT or OTEL_ATTRIBUTE_VALUE_LENGTH_LIMIT when the environment sets one.
 */
export function resolveValueLimitBytes(explicit?: number): number {
  let limit = explicit !== undefined && explicit > 0 ? Math.floor(explicit) : DEFAULT_VALUE_LIMIT_BYTES;
  for (const name of ["OTEL_SPAN_ATTRIBUTE_VALUE_LENGTH_LIMIT", "OTEL_ATTRIBUTE_VALUE_LENGTH_LIMIT"]) {
    const raw = typeof process !== "undefined" ? process.env?.[name] : undefined;
    const env = raw === undefined || raw.trim() === "" ? NaN : Number(raw);
    if (Number.isInteger(env) && env > 0) {
      limit = Math.min(limit, env);
      break;
    }
  }
  return limit;
}

function unitBytes(code: number): number {
  if (code < 0x80) return 1;
  if (code < 0x800) return 2;
  return 3;
}

const isHigh = (code: number): boolean => code >= 0xd800 && code <= 0xdbff;
const isLow = (code: number): boolean => code >= 0xdc00 && code <= 0xdfff;

/** A string's UTF-8 size. A lone surrogate counts three bytes, as the encoder writes U+FFFD for it. */
export function utf8Length(s: string): number {
  if (typeof Buffer !== "undefined") return Buffer.byteLength(s, "utf8");
  let n = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (isHigh(c) && i + 1 < s.length && isLow(s.charCodeAt(i + 1))) {
      n += 4;
      i++;
    } else {
      n += unitBytes(c);
    }
  }
  return n;
}

/** Whether `s` is over `limit` bytes, measuring only when its length cannot tell. */
export function exceedsBytes(s: string, limit: number): boolean {
  // One UTF-16 unit is at least one UTF-8 byte and at most three.
  if (s.length > limit) return true;
  if (s.length * 3 <= limit) return false;
  return utf8Length(s) > limit;
}

/** The longest start of `s` within `bytes`, never ending inside a surrogate pair. */
export function prefixWithin(s: string, bytes: number): string {
  let used = 0;
  let i = 0;
  while (i < s.length) {
    const c = s.charCodeAt(i);
    let width: number;
    let step = 1;
    if (isHigh(c) && i + 1 < s.length && isLow(s.charCodeAt(i + 1))) {
      width = 4;
      step = 2;
    } else {
      width = unitBytes(c);
    }
    if (used + width > bytes) break;
    used += width;
    i += step;
  }
  return s.slice(0, i);
}

/** The longest end of `s` within `bytes`, never starting inside a surrogate pair. */
export function suffixWithin(s: string, bytes: number): string {
  let used = 0;
  let i = s.length;
  while (i > 0) {
    const c = s.charCodeAt(i - 1);
    let width: number;
    let step = 1;
    if (isLow(c) && i - 2 >= 0 && isHigh(s.charCodeAt(i - 2))) {
      width = 4;
      step = 2;
    } else {
      width = unitBytes(c);
    }
    if (used + width > bytes) break;
    used += width;
    i -= step;
  }
  return s.slice(i);
}

export interface CutValue {
  value: string;
  /** The value's size before the cut, in UTF-8 bytes. */
  originalBytes: number;
}

const marker = (cut: number): string => `…[cut ${cut} bytes]…`;

/**
 * `value` within `limit` bytes, keeping its start and its end around a `…[cut N bytes]…` marker; undefined
 * when it already fits. Both ends are kept because a conversation's newest messages are at the end of a
 * request body and its oldest, with the instructions, at the start.
 */
export function cutMiddle(value: string, limit: number = valueLimit): CutValue | undefined {
  if (!exceedsBytes(value, limit)) return undefined;
  const total = utf8Length(value);
  // The marker is sized for the largest count it could name, so the result never exceeds the limit.
  const keep = limit - utf8Length(marker(total));
  if (keep <= 0) return { value: prefixWithin(value, limit), originalBytes: total };
  const head = prefixWithin(value, Math.ceil(keep / 2));
  const tail = suffixWithin(value, Math.floor(keep / 2));
  const removed = total - utf8Length(head) - utf8Length(tail);
  return { value: head + marker(removed) + tail, originalBytes: total };
}

/** `value` within `limit` bytes, keeping its start and ending in `…` when cut. */
export function cutEnd(value: string, limit: number): string {
  if (!exceedsBytes(value, limit)) return value;
  return prefixWithin(value, Math.max(0, limit - 3)) + "…";
}
