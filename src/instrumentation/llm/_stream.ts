import { context as otelContext } from "@opentelemetry/api";
import type { Context as OtelContext } from "@opentelemetry/api";
import { asError, swallow } from "../../core/guard.js";
import type { NormalizedToolCall } from "./_toolcalls.js";

/**
 * How the SDK reads a provider's stream: every chunk as the app reads it, without reading ahead for the app
 * and without replacing the object the app was given when that can be avoided.
 *
 * The rules every provider follows: the clock starts before the request is sent; only generated text
 * (reply, reasoning or refusal) stops it, so a reply made only of tool calls has no time to first token; a
 * stream that fails ends its span as an error and keeps the text that arrived; a stream the app stops
 * reading, aborts, or drops unread ends its span as it stood, once.
 */

/** Assembled reply text kept per stream; past it the text is cut, as a span holds a reply, not a transcript. */
export const STREAM_TEXT_MAX = 256 * 1024;

/** The longest tool-call argument string kept, as for a call that did not stream. */
export const STREAM_ARGS_MAX = 32768;

export class StreamText {
  private parts: string[] = [];
  private length = 0;
  private cut = false;

  append(text: unknown): boolean {
    if (typeof text !== "string" || text === "") return false;
    if (this.length < STREAM_TEXT_MAX) {
      const room = STREAM_TEXT_MAX - this.length;
      const kept = text.length > room ? text.slice(0, room) : text;
      this.parts.push(kept);
      this.length += kept.length;
      if (kept.length < text.length) this.cut = true;
    } else {
      this.cut = true;
    }
    return true;
  }

  get empty(): boolean {
    return this.length === 0;
  }

  toString(): string {
    const text = this.parts.join("");
    return this.cut ? `${text}…` : text;
  }
}

type ToolEntry = { id: string; name: string; args: string; value?: unknown; cut: boolean };

/** Tool calls assembled from stream deltas: a name, an id and argument fragments, by the delta's index. */
export class StreamToolCalls {
  private readonly entries: ToolEntry[] = [];
  private readonly byKey = new Map<string, ToolEntry>();

  entry(key: string): ToolEntry {
    let entry = this.byKey.get(key);
    if (!entry) {
      entry = { id: "", name: "", args: "", cut: false };
      this.entries.push(entry);
      this.byKey.set(key, entry);
    }
    return entry;
  }

  /** A call that arrived whole, as Gemini and Cohere's v1 API send them. */
  add(name: unknown, args: unknown, id?: unknown): void {
    const entry: ToolEntry = { id: "", name: "", args: "", cut: false };
    this.entries.push(entry);
    this.describe(entry, name, id);
    this.setArguments(entry, args);
  }

  describe(entry: ToolEntry, name: unknown, id?: unknown): void {
    if (typeof name === "string" && name) entry.name = name;
    if (typeof id === "string" && id && id !== "null") entry.id = id;
  }

  /** A JSON fragment to append, or arguments that arrived as a value. */
  appendArguments(entry: ToolEntry, fragment: unknown): void {
    if (fragment === undefined || fragment === null || fragment === "") return;
    if (typeof fragment !== "string") {
      this.setArguments(entry, fragment);
      return;
    }
    if (entry.args.length >= STREAM_ARGS_MAX) {
      entry.cut = true;
      return;
    }
    const room = STREAM_ARGS_MAX - entry.args.length;
    entry.args += fragment.length > room ? fragment.slice(0, room) : fragment;
    if (fragment.length > room) entry.cut = true;
  }

  setArguments(entry: ToolEntry, args: unknown): void {
    if (args === undefined || args === null) return;
    if (typeof args === "string") {
      entry.args = "";
      entry.value = undefined;
      this.appendArguments(entry, args);
      return;
    }
    entry.value = args;
    entry.args = "";
  }

  get size(): number {
    return this.entries.length;
  }

  calls(): NormalizedToolCall[] {
    const out: NormalizedToolCall[] = [];
    for (const entry of this.entries) {
      if (!entry.name) continue;
      out.push({ name: entry.name, id: entry.id, argsJson: argumentsJson(entry) });
    }
    return out;
  }
}

function argumentsJson(entry: ToolEntry): string {
  if (entry.args) return entry.cut ? `${entry.args}…` : entry.args;
  if (entry.value === undefined) return "{}";
  try {
    const json = JSON.stringify(entry.value) ?? "{}";
    return json.length > STREAM_ARGS_MAX ? `${json.slice(0, STREAM_ARGS_MAX)}…` : json;
  } catch {
    return "{}";
  }
}

/** Time to the first generated text, measured from a clock started before the request was sent. */
export class FirstToken {
  private ms: number | undefined;

  constructor(private readonly startMs: number) {}

  mark(): void {
    if (this.ms === undefined) this.ms = Date.now() - this.startMs;
  }

  /** The attribute for a stream that ended; none for one that failed or produced no text. */
  attributes(error?: Error): Record<string, number> {
    return !error && this.ms !== undefined ? { "gen_ai.server.time_to_first_token_ms": this.ms } : {};
  }
}

type AnyIterator = AsyncIterator<unknown> & { return?: (value?: unknown) => Promise<IteratorResult<unknown>>; throw?: (err?: unknown) => Promise<IteratorResult<unknown>> };

/** Ends a stream's span once, however many of the stream's ends report it. */
function once(onEnd: (error?: Error) => void): (error?: unknown) => void {
  let ended = false;
  return (error?: unknown) => {
    if (ended) return;
    ended = true;
    try {
      onEnd(error === undefined ? undefined : asError(error));
    } catch (err) {
      swallow("ending a stream span", err);
    }
  };
}

// A stream the app drops without reading it ends its span when it is collected. The callback holds only
// what ends the span, never the stream, or the stream could never be collected.
type EndRegistry = { register(target: object, end: (error?: unknown) => void): void };
type EndRegistryClass = new (cleanup: (end: (error?: unknown) => void) => void) => EndRegistry;
const Registry = (globalThis as { FinalizationRegistry?: EndRegistryClass }).FinalizationRegistry;
const unread: EndRegistry | undefined = Registry ? new Registry((end) => end()) : undefined;

function observeIterator(inner: AnyIterator, see: (chunk: unknown) => void, end: (error?: unknown) => void, runIn?: OtelContext): AnyIterator {
  return {
    async next(...args: [] | [unknown]) {
      let result: IteratorResult<unknown>;
      try {
        result = await (runIn ? otelContext.with(runIn, () => inner.next(...args)) : inner.next(...args));
      } catch (err) {
        end(err);
        throw err;
      }
      if (result.done) end();
      else see(result.value);
      return result;
    },
    async return(value?: unknown) {
      end();
      return typeof inner.return === "function" ? inner.return(value) : { done: true, value };
    },
    async throw(err?: unknown) {
      end(err);
      if (typeof inner.throw === "function") return inner.throw(err);
      throw err;
    },
    [Symbol.asyncIterator]() {
      return this;
    },
  } as AnyIterator;
}

// A stream aborted by the app ends as it stood. The SDKs also abort their own stream when it fails, from
// inside the iterator, before the failure reaches the app; the abort is acted on a turn later, so that
// failure is recorded as the error it is.
function watchAbort(signal: unknown, end: (error?: unknown) => void): void {
  const s = signal as { aborted?: boolean; addEventListener?: (type: string, fn: () => void, opts?: unknown) => void } | undefined;
  if (!s || typeof s.addEventListener !== "function") return;
  const later = (): void => {
    setTimeout(() => end(), 0);
  };
  if (s.aborted) {
    later();
    return;
  }
  s.addEventListener("abort", later, { once: true });
}

/**
 * Lets `onChunk` see each chunk of `stream` as the app reads it, and calls `onEnd` once when the stream is
 * done, fails, is left early, is aborted or is collected unread. An OpenAI or Anthropic `Stream` is kept as
 * the same object with its iterator wrapped in place, so `controller`, `tee()`, `toReadableStream()` and the
 * SDKs' stream helpers keep working; any other async iterable is wrapped in a Proxy that forwards everything
 * else to it. A value that is not a stream is returned as it is, its span ended.
 */
export function observeStream<T>(
  stream: T,
  onChunk: (chunk: any) => void,
  onEnd: (error?: Error) => void,
  /** A context each step of the stream runs in, for a stream whose producer does its work as it is read. */
  runIn?: OtelContext,
): T {
  const end = once(onEnd);
  const see = (chunk: unknown): void => {
    try {
      onChunk(chunk);
    } catch (err) {
      swallow("reading a stream chunk", err);
    }
  };
  const s = stream as any;
  if (!s || (typeof s !== "object" && typeof s !== "function") || typeof s[Symbol.asyncIterator] !== "function") {
    end();
    return stream;
  }

  if (typeof s.iterator === "function") {
    try {
      const original = s.iterator as (...args: unknown[]) => AnyIterator;
      s.iterator = function (this: unknown, ...args: unknown[]) {
        return observeIterator(original.apply(this, args), see, end, runIn);
      };
      watchAbort(s.controller?.signal, end);
      unread?.register(s, end);
      return stream;
    } catch (err) {
      swallow("wrapping a stream's iterator", err);
    }
  }

  let shared: AnyIterator | undefined;
  const selfIterating = typeof s.next === "function";
  const iterator = (): AnyIterator => {
    if (selfIterating) return (shared ??= observeIterator(s[Symbol.asyncIterator](), see, end, runIn));
    return observeIterator(s[Symbol.asyncIterator](), see, end, runIn);
  };
  try {
    const proxy = new Proxy(s, {
      get(target, prop) {
        if (prop === Symbol.asyncIterator) return iterator;
        if (selfIterating && (prop === "next" || prop === "return" || prop === "throw")) {
          const it = iterator();
          const method = (it as any)[prop];
          return typeof method === "function" ? method.bind(it) : method;
        }
        const value = Reflect.get(target, prop, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    watchAbort(s.controller?.signal, end);
    unread?.register(proxy, end);
    return proxy as T;
  } catch (err) {
    swallow("wrapping a stream", err);
    end();
    return stream;
  }
}
