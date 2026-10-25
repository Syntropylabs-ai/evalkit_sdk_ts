import { SpanStatusCode } from "@opentelemetry/api";
import type { AttributeValue, Span } from "@opentelemetry/api";
import { cutEnd, cutMiddle } from "./truncate.js";
import { boundedText, safeString } from "./serialize.js";

// How an error is recorded on a span, shared with the Python SDK and the receiver:
//
//   status       ERROR, described as "<Type>: <message>"
//   event        "exception": exception.type, exception.message (<= 2 KiB), exception.stacktrace (<= 16 KiB,
//                cut in the middle), exception.escaped (true when the error propagated out of the span)
//   attributes   error.type, error.message, error.source, error.stack (<= 8192)
//                evalkit.exception.frames      JSON, <= 64 frames, innermost first:
//                                              {"file","line","col","function","module"?,"in_app"}
//                evalkit.exception.source      "file:line" of the innermost in-app frame
//                evalkit.exception.causes      JSON, <= 5 {"type","message","frames"?} from error.cause chains
//                                              and AggregateError.errors
//                evalkit.exception.fingerprint only when the app set one (setErrorFingerprint)

export const EXCEPTION_EVENT = "exception";
export const MAX_FRAMES = 64;
export const MAX_CAUSE_FRAMES = 16;
export const MAX_CAUSES = 5;
export const MAX_MESSAGE_BYTES = 2 * 1024;
export const MAX_STACKTRACE_BYTES = 16 * 1024;
const MAX_ERROR_STACK = 8192;
const MAX_FINGERPRINT = 1024;

export interface StackFrame {
  file: string;
  line: number;
  col: number;
  function: string;
  module?: string;
  in_app: boolean;
}

export type InAppMatcher = string | RegExp;

let inAppInclude: InAppMatcher[] = [];
let inAppExclude: InAppMatcher[] = [];

// V8 records ten frames unless told otherwise; the SDK raises the limit only from that untouched default, or
// from the value it set itself, so an app that chose its own limit keeps it.
const V8_DEFAULT_STACK_LIMIT = 10;
let stackLimitSetBySdk: number | undefined;

export interface ExceptionOptions {
  inAppInclude?: InAppMatcher[];
  inAppExclude?: InAppMatcher[];
  stackTraceLimit?: number;
  sourceMaps?: boolean;
}

export function configureExceptions(options: ExceptionOptions): void {
  inAppInclude = Array.isArray(options.inAppInclude) ? options.inAppInclude.filter(isMatcher) : [];
  inAppExclude = Array.isArray(options.inAppExclude) ? options.inAppExclude.filter(isMatcher) : [];
  applyStackTraceLimit(options.stackTraceLimit);
  if (options.sourceMaps) {
    try {
      const enable = (process as { setSourceMapsEnabled?: (on: boolean) => void }).setSourceMapsEnabled;
      if (typeof enable === "function") enable.call(process, true);
    } catch {
      // A runtime without source map support keeps the generated positions.
    }
  }
}

function isMatcher(m: unknown): m is InAppMatcher {
  return typeof m === "string" ? m.length > 0 : m instanceof RegExp;
}

function applyStackTraceLimit(limit: number | undefined): void {
  if (limit === undefined || !Number.isFinite(limit) || limit <= 0) return;
  try {
    const current = Error.stackTraceLimit;
    const untouched = current === V8_DEFAULT_STACK_LIMIT || (stackLimitSetBySdk !== undefined && current === stackLimitSetBySdk);
    if (!untouched || typeof current !== "number") return;
    if (limit <= current && current !== stackLimitSetBySdk) return;
    Error.stackTraceLimit = Math.floor(limit);
    stackLimitSetBySdk = Error.stackTraceLimit;
  } catch {
    // A frozen Error constructor keeps its limit.
  }
}

function matches(m: InAppMatcher, file: string): boolean {
  if (typeof m === "string") return file.includes(m);
  m.lastIndex = 0;
  return m.test(file);
}

/** In-app is code of the app's own: not Node's (`node:`, `internal/`) and not a dependency (`node_modules`). */
export function isInApp(file: string): boolean {
  if (inAppExclude.some((m) => matches(m, file))) return false;
  if (inAppInclude.some((m) => matches(m, file))) return true;
  if (file.startsWith("node:") || file.startsWith("internal/")) return false;
  if (file.includes("/node_modules/") || file.includes("\\node_modules\\")) return false;
  if (file === "native" || file.startsWith("<")) return false;
  return true;
}

/** The package a dependency's frame belongs to: `openai`, `@scope/name`. */
function moduleOf(file: string): string | undefined {
  const marker = file.includes("/node_modules/") ? "/node_modules/" : file.includes("\\node_modules\\") ? "\\node_modules\\" : undefined;
  if (!marker) return undefined;
  const rest = file.slice(file.lastIndexOf(marker) + marker.length);
  const parts = rest.split(/[\\/]/);
  if (!parts[0]) return undefined;
  return parts[0].startsWith("@") && parts[1] ? `${parts[0]}/${parts[1]}` : parts[0];
}

const LOCATION = /^(.*):(\d+):(\d+)$/;

/** The index of the parenthesis that opens the one closing `text`. */
function openingParen(text: string): number {
  let depth = 0;
  for (let i = text.length - 1; i >= 0; i--) {
    const c = text[i];
    if (c === ")") depth++;
    else if (c === "(") {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

function parseFrame(line: string): StackFrame | undefined {
  let body = line.trim();
  if (!body.startsWith("at ")) return undefined;
  body = body.slice(3);
  if (body.startsWith("async ")) body = body.slice(6);
  let fn = "";
  let location = body;
  if (body.endsWith(")")) {
    const open = openingParen(body);
    if (open > 0) {
      fn = body.slice(0, open).trim();
      location = body.slice(open + 1, -1);
    } else if (open === 0) {
      location = body.slice(1, -1);
    }
  }
  const m = LOCATION.exec(location);
  // `native`, `<anonymous>` and `index 0` (Promise.all) name no place in a file.
  if (!m) return undefined;
  let file = m[1];
  if (file.startsWith("file://")) {
    file = file.slice(7);
    try {
      file = decodeURIComponent(file);
    } catch {
      // Kept as written.
    }
  }
  const frame: StackFrame = {
    file,
    line: Number(m[2]),
    col: Number(m[3]),
    function: fn || "<anonymous>",
    in_app: isInApp(file),
  };
  const mod = moduleOf(file);
  if (mod) frame.module = mod;
  return frame;
}

/**
 * The frames of a V8 stack (`at fn (file:line:col)`, `at file:line:col`, `at async fn (...)`), innermost
 * first as V8 lists them. Only `error.stack` is read: Error.prepareStackTrace stays the app's.
 */
export function parseStack(stack: unknown, max: number = MAX_FRAMES): StackFrame[] {
  if (typeof stack !== "string" || stack === "") return [];
  // The message comes first and may be long or span lines; frames start at the first "at" line.
  let from = 0;
  if (!stack.startsWith("    at ")) {
    const at = stack.indexOf("\n    at ");
    if (at < 0) return [];
    from = at + 1;
  }
  const frames: StackFrame[] = [];
  while (from < stack.length && frames.length < max) {
    let to = stack.indexOf("\n", from);
    if (to < 0) to = stack.length;
    const frame = parseFrame(stack.slice(from, to));
    if (frame) frames.push(frame);
    from = to + 1;
  }
  return frames;
}

/** `file:line:col` of the first frame outside Node and node_modules, else of the first frame: `error.source`. */
export function firstStackFrame(stack?: string): string | undefined {
  if (!stack) return undefined;
  const lines = stack.split("\n").slice(1);
  const grab = (l: string) => l.match(/\(?([^\s()]+:\d+:\d+)\)?\s*$/)?.[1];
  for (const l of lines) {
    const f = grab(l);
    if (f && !f.includes("node:internal") && !f.includes("/node_modules/") && !f.includes("\\node_modules\\")) return f;
  }
  for (const l of lines) {
    const f = grab(l);
    if (f) return f;
  }
  return undefined;
}

/** `file:line` of the innermost in-app frame. */
export function sourceOf(frames: StackFrame[]): string | undefined {
  const own = frames.find((f) => f.in_app);
  return own ? `${own.file}:${own.line}` : undefined;
}

function isErrorLike(value: unknown): value is { name?: unknown; message?: unknown; stack?: unknown } {
  if (value instanceof Error) return true;
  if (!value || typeof value !== "object") return false;
  try {
    const v = value as { message?: unknown; stack?: unknown };
    return typeof v.message === "string" || typeof v.stack === "string";
  } catch {
    return false;
  }
}

/** An error's type: its name, or its class's name when the name is only the inherited "Error". */
export function exceptionType(error: unknown): string {
  if (!isErrorLike(error)) return "Error";
  try {
    const name = typeof error.name === "string" ? error.name : "";
    if (name && name !== "Error") return name;
    const ctor = (error as { constructor?: { name?: unknown } }).constructor?.name;
    if (typeof ctor === "string" && ctor && ctor !== "Error" && ctor !== "Object") return ctor;
    return name || "Error";
  } catch {
    return "Error";
  }
}

function rawMessage(error: unknown): string {
  try {
    if (isErrorLike(error)) return typeof error.message === "string" ? error.message : safeString(error.message ?? "");
    if (typeof error === "string") return error;
    return boundedText(error, MAX_MESSAGE_BYTES) ?? safeString(error);
  } catch {
    return "";
  }
}

function rawStack(error: unknown): string | undefined {
  try {
    if (!isErrorLike(error)) return undefined;
    return typeof error.stack === "string" ? error.stack : undefined;
  } catch {
    return undefined;
  }
}

const fingerprints = new WeakMap<object, string>();

/**
 * Groups this error with others under `fingerprint` instead of by its type and frames. It applies wherever
 * the error is recorded; the error itself is returned, so `throw setErrorFingerprint(new Error(...), "x")`.
 */
export function setErrorFingerprint<T>(error: T, fingerprint: string): T {
  try {
    if (error && typeof error === "object" && typeof fingerprint === "string" && fingerprint !== "") {
      fingerprints.set(error as object, fingerprint.slice(0, MAX_FINGERPRINT));
    }
  } catch {
    // A frozen or exotic value keeps no fingerprint.
  }
  return error;
}

interface CauseRecord {
  type: string;
  message: string;
  frames?: StackFrame[];
}

function causesOf(error: unknown): CauseRecord[] {
  const out: CauseRecord[] = [];
  const seen = new Set<unknown>([error]);
  const queue: unknown[] = [error];
  while (queue.length > 0 && out.length < MAX_CAUSES) {
    const current = queue.shift();
    const next: unknown[] = [];
    try {
      const c = current as { cause?: unknown; errors?: unknown };
      if (c && typeof c === "object") {
        if (c.cause !== undefined && c.cause !== null) next.push(c.cause);
        if (Array.isArray(c.errors)) {
          // AggregateError's members, or the errors another library groups the same way.
          const Aggregate = (globalThis as { AggregateError?: new (...args: never[]) => unknown }).AggregateError;
          const aggregate = typeof Aggregate === "function" && c instanceof Aggregate;
          for (const item of c.errors.slice(0, MAX_CAUSES)) if (aggregate || isErrorLike(item)) next.push(item);
        }
      }
    } catch {
      continue;
    }
    for (const item of next) {
      if (seen.has(item) || out.length >= MAX_CAUSES) continue;
      seen.add(item);
      const record: CauseRecord = { type: exceptionType(item), message: cutEnd(rawMessage(item), MAX_MESSAGE_BYTES) };
      const frames = parseStack(rawStack(item), MAX_CAUSE_FRAMES);
      if (frames.length) record.frames = frames;
      out.push(record);
      queue.push(item);
    }
  }
  return out;
}

export interface DescribedError {
  type: string;
  message: string;
  stacktrace?: string;
  status: string;
  attributes: Record<string, AttributeValue>;
}

/** Everything the contract records about `error`, every field capped. */
export function describeError(error: unknown): DescribedError {
  const type = exceptionType(error);
  const message = cutEnd(rawMessage(error), MAX_MESSAGE_BYTES);
  const stack = rawStack(error);
  const stacktrace = stack === undefined ? undefined : cutMiddle(stack, MAX_STACKTRACE_BYTES)?.value ?? stack;
  const attributes: Record<string, AttributeValue> = {
    "error.type": type,
    "error.message": message,
  };
  if (stack) {
    try {
      const legacySource = firstStackFrame(stack);
      if (legacySource) attributes["error.source"] = legacySource;
    } catch {
      // Without a readable frame there is no source to name.
    }
    attributes["error.stack"] = stack.length > MAX_ERROR_STACK ? stack.slice(0, MAX_ERROR_STACK) + "…" : stack;
    const frames = parseStack(stack);
    if (frames.length) {
      attributes["evalkit.exception.frames"] = JSON.stringify(frames);
      const source = sourceOf(frames);
      if (source) attributes["evalkit.exception.source"] = source;
    }
  }
  const causes = causesOf(error);
  if (causes.length) attributes["evalkit.exception.causes"] = JSON.stringify(causes);
  const fingerprint = error && typeof error === "object" ? fingerprints.get(error as object) : undefined;
  if (fingerprint) attributes["evalkit.exception.fingerprint"] = fingerprint;
  return { type, message, stacktrace, status: message ? `${type}: ${message}` : type, attributes };
}

// Spans an error was recorded on, so a later status set by response code does not replace its description,
// and the errors each one recorded, so an error that passes two hooks of one span is one event.
const recorded = new WeakMap<object, Set<unknown>>();

export function hasRecordedError(span: unknown): boolean {
  return !!span && typeof span === "object" && recorded.has(span);
}

export interface RecordErrorOptions {
  /** Whether the error propagated out of the span (it was rethrown to the caller). */
  escaped?: boolean;
  fingerprint?: string;
}

/**
 * Records `error` on `span` by the contract above and sets the span's status to ERROR. A span that is not
 * recording (sampled out) costs nothing, and nothing here throws.
 */
export function recordError(span: Span | undefined, error: unknown, options: RecordErrorOptions = {}): void {
  if (!span) return;
  try {
    if (typeof span.isRecording === "function" && !span.isRecording()) return;
    let seen = recorded.get(span);
    if (seen?.has(error)) return;
    if (!seen) {
      seen = new Set();
      recorded.set(span, seen);
    }
    if (seen.size < 16) seen.add(error);
    if (options.fingerprint) setErrorFingerprint(error, options.fingerprint);
    const info = describeError(error);
    const event: Record<string, AttributeValue> = {
      "exception.type": info.type,
      "exception.message": info.message,
      "exception.escaped": options.escaped === true,
    };
    if (info.stacktrace) event["exception.stacktrace"] = info.stacktrace;
    span.addEvent(EXCEPTION_EVENT, event);
    span.setAttributes(info.attributes);
    span.setStatus({ code: SpanStatusCode.ERROR, message: info.status });
  } catch {
    // Recording is best effort; the app's own error handling goes on untouched.
  }
}

/**
 * Brings an exception event another library recorded within the contract's caps; the frames and source
 * are derived from its stack when the span has none of its own. Used at export, on a copy of the span.
 */
export function normaliseExceptionEvent(
  attributes: Record<string, unknown> | undefined,
): { attributes: Record<string, unknown> | undefined; frames?: string; source?: string } {
  if (!attributes) return { attributes };
  const out: Record<string, unknown> = { ...attributes };
  const message = out["exception.message"];
  if (typeof message === "string") out["exception.message"] = cutEnd(message, MAX_MESSAGE_BYTES);
  const stack = out["exception.stacktrace"];
  let frames: string | undefined;
  let source: string | undefined;
  if (typeof stack === "string") {
    out["exception.stacktrace"] = cutMiddle(stack, MAX_STACKTRACE_BYTES)?.value ?? stack;
    const parsed = parseStack(stack);
    if (parsed.length) {
      frames = JSON.stringify(parsed);
      source = sourceOf(parsed);
    }
  }
  return { attributes: out, frames, source };
}
