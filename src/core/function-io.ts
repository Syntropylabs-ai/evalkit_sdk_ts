import { MASK } from "../utils/headers.js";
import { isSecretName, scrubString } from "./secrets.js";
import { boundedJson, safeString } from "./serialize.js";

/** The most of a function's arguments or result one attribute records. */
export const IO_MAX = 4096;

type Param = { name?: string; rest: boolean };

const IDENTIFIER = /^[A-Za-z_$][\w$]*/;

/**
 * The index past the parenthesis that closes the one at `open`, with the text between it and `open`
 * without comments; undefined where the list cannot be read with certainty (a template or regular
 * expression literal in a default value).
 */
function parameterSource(src: string, open: number): string | undefined {
  let depth = 0;
  let out = "";
  for (let i = open; i < src.length; i++) {
    const c = src[i];
    if (c === "/" && src[i + 1] === "/") {
      const nl = src.indexOf("\n", i);
      if (nl < 0) return undefined;
      i = nl;
      continue;
    }
    if (c === "/" && src[i + 1] === "*") {
      const close = src.indexOf("*/", i + 2);
      if (close < 0) return undefined;
      i = close + 1;
      continue;
    }
    if (c === "`" || c === "/") return undefined;
    if (c === "'" || c === '"') {
      let j = i + 1;
      while (j < src.length && src[j] !== c) j += src[j] === "\\" ? 2 : 1;
      if (j >= src.length) return undefined;
      out += src.slice(i, j + 1);
      i = j;
      continue;
    }
    if (c === "(" || c === "[" || c === "{") depth++;
    if (c === ")" || c === "]" || c === "}") {
      depth--;
      if (depth === 0) return out.slice(1);
    }
    out += c;
  }
  return undefined;
}

function splitTopLevel(list: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let current = "";
  for (let i = 0; i < list.length; i++) {
    const c = list[i];
    if (c === "'" || c === '"') {
      let j = i + 1;
      while (j < list.length && list[j] !== c) j += list[j] === "\\" ? 2 : 1;
      current += list.slice(i, j + 1);
      i = j;
      continue;
    }
    if (c === "(" || c === "[" || c === "{") depth++;
    if (c === ")" || c === "]" || c === "}") depth--;
    if (c === "," && depth === 0) {
      parts.push(current);
      current = "";
      continue;
    }
    current += c;
  }
  if (current.trim() !== "") parts.push(current);
  return parts;
}

/**
 * A function's parameters as its source declares them. A destructured parameter has no name of its own,
 * and the list is undefined for what has no readable source: a native or bound function, a class, or a
 * parameter list this reading cannot be sure of. Minified code keeps its parameter names, one letter each,
 * which name nothing.
 */
export function parametersOf(fn: Function): Param[] | undefined {
  let src: string;
  try {
    src = Function.prototype.toString.call(fn);
  } catch {
    return undefined;
  }
  if (/\[native code\]\s*\}\s*$/.test(src) || /^class\b/.test(src)) return undefined;
  const bare = /^(?:async\s+)?([A-Za-z_$][\w$]*)\s*=>/.exec(src);
  if (bare) return [{ name: bare[1], rest: false }];
  const open = src.indexOf("(");
  if (open < 0) return undefined;
  const list = parameterSource(src, open);
  if (list === undefined) return undefined;
  return splitTopLevel(list).map((raw) => {
    let text = raw.trim();
    const rest = text.startsWith("...");
    if (rest) text = text.slice(3).trim();
    const name = text.startsWith("{") || text.startsWith("[") ? undefined : IDENTIFIER.exec(text)?.[0];
    return { name, rest };
  });
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/**
 * What a traced function's arguments and result are recorded as. Each argument is matched to the parameter
 * it is bound to, and one whose parameter is named like a credential is recorded as `***`; so is a member of
 * an options object named that way, as a keyword argument is in the Python SDK. A function whose own name
 * reads like a credential's (getApiKey, validateToken) records neither its arguments nor its result.
 */
export class FunctionIO {
  private readonly secretAt: boolean[];
  private readonly secretRest: boolean;
  readonly secretFunction: boolean;

  constructor(fn: Function, spanName: string) {
    const params = parametersOf(fn) ?? [];
    this.secretAt = params.filter((p) => !p.rest).map((p) => !!p.name && isSecretName(p.name));
    const rest = params.find((p) => p.rest);
    this.secretRest = !!rest?.name && isSecretName(rest.name);
    const ownName = String(fn.name ?? "").replace(/^bound /, "");
    const lastSegment = spanName.split(".").pop() ?? "";
    this.secretFunction = isSecretName(ownName) || isSecretName(lastSegment);
  }

  /** The arguments with the ones named like credentials withheld. */
  arguments(args: unknown[]): unknown[] {
    return args.map((value, index) => {
      const secret = index < this.secretAt.length ? this.secretAt[index] : this.secretRest;
      if (secret) return MASK;
      if (!isPlainObject(value)) return value;
      const out: Record<string, unknown> = {};
      for (const [key, item] of Object.entries(value)) out[key] = isSecretName(key) ? MASK : item;
      return out;
    });
  }
}

/**
 * A recorded value as JSON cut to `limit`, written only as far as the limit: a large argument costs the call
 * no more than what is kept. With `scrub`, secrets are masked as each part is written, before any cut: cut
 * JSON no longer parses, and the scrubber at export could then recognise a credential only by its shape.
 */
export function ioString(value: unknown, scrub: boolean, limit: number = IO_MAX): string | undefined {
  if (value === undefined) return undefined;
  const json = boundedJson(value, limit, scrub);
  if (json) return json.cut ? json.text + "…" : json.text;
  let s = safeString(value);
  if (s.length > limit + 1024) s = s.slice(0, limit + 1024);
  if (scrub) s = scrubString(s);
  return s.length > limit ? s.slice(0, limit) + "…" : s;
}
