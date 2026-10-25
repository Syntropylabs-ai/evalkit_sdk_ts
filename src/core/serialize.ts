import { MASK } from "../utils/headers.js";
import { isSecretKey, scrubValue } from "./secrets.js";

// Recording a value the app passed (a function's arguments, a request body, a console argument) must cost a
// bounded amount whatever the value is. JSON.stringify walks all of it before anything can be cut, throws on
// a BigInt or a cycle, and runs every getter: a 100 MB array or a self-referencing object costs the app's
// own request that time, or throws inside it.

// Deeper than this, a value is written as a placeholder. Every level writes at least one character, so the
// cap bounds depth too, but a cap of a few MiB would allow a recursion deep enough to exhaust the stack.
const MAX_DEPTH = 100;

// A string is scrubbed with this much of it past the cut, so a credential that straddles the cut is still
// recognised by its whole shape (the longest assignment the scrubber reads is 1024 characters).
const SCRUB_MARGIN = 1024;

const PLACEHOLDER_CIRCULAR = '"[Circular]"';
const PLACEHOLDER_DEEP = '"[Object]"';
const PLACEHOLDER_UNREADABLE = '"[Unserializable]"';

class Budget {
  private readonly parts: string[] = [];
  private size = 0;
  cut = false;

  constructor(private readonly limit: number) {}

  get room(): number {
    return this.limit - this.size;
  }

  get full(): boolean {
    return this.cut;
  }

  push(text: string): void {
    if (this.cut || text.length === 0) return;
    const room = this.limit - this.size;
    if (text.length > room) {
      this.parts.push(text.slice(0, room));
      this.size = this.limit;
      this.cut = true;
      return;
    }
    this.parts.push(text);
    this.size += text.length;
  }

  text(): string {
    return this.parts.join("");
  }
}

interface Walk {
  budget: Budget;
  scrub: boolean;
  seen: Set<object>;
}

function viewSummary(value: object): string | undefined {
  if (ArrayBuffer.isView(value)) {
    const name = (value as { constructor?: { name?: string } }).constructor?.name || "ArrayBufferView";
    return JSON.stringify(`[${name} ${(value as ArrayBufferView).byteLength} bytes]`);
  }
  if (value instanceof ArrayBuffer) return JSON.stringify(`[ArrayBuffer ${value.byteLength} bytes]`);
  return undefined;
}

function writeString(walk: Walk, value: string): void {
  const room = walk.budget.room;
  // One unit past the room keeps a surrogate pair at the cut whole; escaping only lengthens the text.
  let piece = value.length > room + 1 ? value.slice(0, room + 1 + (walk.scrub ? SCRUB_MARGIN : 0)) : value;
  if (walk.scrub) {
    const scrubbed = scrubValue(piece);
    piece = typeof scrubbed === "string" ? scrubbed : piece;
  }
  walk.budget.push(JSON.stringify(piece.length > room + 1 ? piece.slice(0, room + 1) : piece));
}

/** Writes `value` as JSON.stringify would; false when JSON omits it (undefined, a function, a symbol). */
function writeValue(walk: Walk, holderKey: string, input: unknown, depth: number): boolean {
  let value = input;
  try {
    if (value !== null && (typeof value === "object" || typeof value === "bigint")) {
      if (typeof value === "object") {
        const summary = viewSummary(value as object);
        if (summary !== undefined) {
          walk.budget.push(summary);
          return true;
        }
      }
      const toJSON = (value as { toJSON?: unknown }).toJSON;
      if (typeof toJSON === "function") value = toJSON.call(value, holderKey);
    }
  } catch {
    walk.budget.push(PLACEHOLDER_UNREADABLE);
    return true;
  }

  if (walk.scrub && holderKey !== "" && isSecretKey(holderKey)) {
    walk.budget.push(JSON.stringify(MASK));
    return true;
  }

  switch (typeof value) {
    case "string":
      writeString(walk, value);
      return true;
    case "number":
      walk.budget.push(Number.isFinite(value) ? String(value) : "null");
      return true;
    case "boolean":
      walk.budget.push(value ? "true" : "false");
      return true;
    case "bigint":
      // JSON has no BigInt, and JSON.stringify throws on one; its digits are kept as a string.
      walk.budget.push(JSON.stringify(value.toString()));
      return true;
    case "undefined":
    case "function":
    case "symbol":
      return false;
  }

  if (value === null) {
    walk.budget.push("null");
    return true;
  }

  const obj = value as object;
  if (obj instanceof Number || obj instanceof String || obj instanceof Boolean) {
    return writeValue(walk, holderKey, obj.valueOf(), depth);
  }
  if (walk.seen.has(obj)) {
    walk.budget.push(PLACEHOLDER_CIRCULAR);
    return true;
  }
  if (depth >= MAX_DEPTH) {
    walk.budget.push(PLACEHOLDER_DEEP);
    return true;
  }

  walk.seen.add(obj);
  try {
    if (Array.isArray(obj)) writeArray(walk, obj, depth);
    else writeObject(walk, obj as Record<string, unknown>, depth);
  } catch {
    walk.budget.push(PLACEHOLDER_UNREADABLE);
  } finally {
    walk.seen.delete(obj);
  }
  return true;
}

function writeArray(walk: Walk, arr: unknown[], depth: number): void {
  walk.budget.push("[");
  const n = arr.length;
  for (let i = 0; i < n && !walk.budget.full; i++) {
    if (i > 0) walk.budget.push(",");
    let item: unknown;
    try {
      item = arr[i];
    } catch {
      walk.budget.push(PLACEHOLDER_UNREADABLE);
      continue;
    }
    if (!writeValue(walk, String(i), item, depth + 1)) walk.budget.push("null");
  }
  walk.budget.push("]");
}

const hasOwn = Object.prototype.hasOwnProperty;

function writeObject(walk: Walk, obj: Record<string, unknown>, depth: number): void {
  walk.budget.push("{");
  let first = true;
  // for...in visits own keys in Object.keys order and can stop early, where Object.keys first lists every key.
  for (const key in obj) {
    if (walk.budget.full) break;
    if (!hasOwn.call(obj, key)) continue;
    let item: unknown;
    try {
      item = obj[key];
    } catch {
      walk.budget.push(`${first ? "" : ","}${JSON.stringify(key)}:${PLACEHOLDER_UNREADABLE}`);
      first = false;
      continue;
    }
    // JSON omits these members.
    if (item === undefined || typeof item === "function" || typeof item === "symbol") continue;
    walk.budget.push(`${first ? "" : ","}${JSON.stringify(key)}:`);
    // Only a toJSON that answers undefined is left to omit; null keeps the text well formed.
    if (!writeValue(walk, key, item, depth + 1)) walk.budget.push("null");
    first = false;
  }
  walk.budget.push("}");
}

export interface BoundedJson {
  text: string;
  /** Whether the value's JSON went past the limit; `text` then holds its first `limit` characters. */
  cut: boolean;
}

/**
 * The JSON of `value`, the same text JSON.stringify writes, stopping once `limit` characters are written
 * instead of serialising the whole value first. Never throws: a BigInt is written as its digits, a cycle as
 * `"[Circular]"`, a getter that throws as `"[Unserializable]"`, a typed array or Buffer by its size. With
 * `scrub`, a member named like a credential is masked and every string is scrubbed, as `scrubbedJson` does.
 * Undefined when JSON has nothing for the value itself (undefined, a function, a symbol).
 */
export function boundedJson(value: unknown, limit: number, scrub = false): BoundedJson | undefined {
  const walk: Walk = { budget: new Budget(Math.max(0, Math.floor(limit))), scrub, seen: new Set() };
  try {
    if (!writeValue(walk, "", value, 0)) return undefined;
  } catch {
    return undefined;
  }
  return { text: walk.budget.text(), cut: walk.budget.cut };
}

/** `String(value)` that never throws (a Symbol.toPrimitive or toString that throws, a revoked Proxy). */
export function safeString(value: unknown): string {
  try {
    return String(value);
  } catch {
    try {
      return Object.prototype.toString.call(value);
    } catch {
      return "[unprintable]";
    }
  }
}

/** A value as text within `limit` characters: JSON where it has some, else its string form; `…` marks a cut. */
export function boundedText(value: unknown, limit: number, scrub = false): string | undefined {
  if (value === undefined) return undefined;
  const json = boundedJson(value, limit, scrub);
  if (json) return json.cut ? `${json.text}…` : json.text;
  const s = safeString(value);
  return s.length > limit ? `${s.slice(0, limit)}…` : s;
}
