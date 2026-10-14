import type { Span } from "@opentelemetry/api";
import type { EvalKitClient } from "../../core/client.js";
import { guarded } from "../../core/guard.js";
import { emitToolCalls, fromGoogleParts } from "./_toolcalls.js";
import { safeBody } from "./_body.js";
import type { GoogleUsage, GoogleUsageMetadata } from "./_google-usage.js";
import { EMPTY_GOOGLE_USAGE, extractGoogleUsage, googleUsageAttributes, mergeGoogleUsage } from "./_google-usage.js";
import { FirstToken, StreamText, StreamToolCalls, observeStream } from "./_stream.js";
import { endSpan, setAttributes } from "./_span.js";

// What a GenerativeModel call (@google/generative-ai, @google-cloud/vertexai) answers with, whole or
// streamed: candidates whose parts are text, thoughts or function calls.

type Part = { text?: string; thought?: boolean; functionCall?: { name?: string; args?: unknown; id?: string } };
export type GenerativeResponse = {
  candidates?: Array<{ content?: { parts?: Part[] }; finishReason?: string }>;
  usageMetadata?: GoogleUsageMetadata;
  modelVersion?: string;
};

export function candidateText(resp: GenerativeResponse | undefined): { completion: string; thinking: string } {
  const parts: string[] = [];
  const thoughts: string[] = [];
  for (const cand of resp?.candidates ?? []) {
    for (const p of cand?.content?.parts ?? []) {
      if (typeof p?.text !== "string" || !p.text) continue;
      if (p.thought) thoughts.push(p.text);
      else parts.push(p.text);
    }
  }
  return { completion: parts.join(""), thinking: thoughts.join("") };
}

export function finishReasonsOf(resp: GenerativeResponse | undefined): string[] {
  const reasons: string[] = [];
  for (const cand of resp?.candidates ?? []) {
    const reason = cand?.finishReason;
    if (typeof reason === "string" && reason && reason !== "FINISH_REASON_UNSPECIFIED" && !reasons.includes(reason)) {
      reasons.push(reason);
    }
  }
  return reasons;
}

function isThenable(value: unknown): value is PromiseLike<unknown> {
  return !!value && typeof (value as PromiseLike<unknown>).then === "function";
}

/**
 * A generateContentStream() result, `{ stream, response }`. The stream is read as the app reads it, for the
 * time to first token and the text that arrived; the span ends when `response`, the whole reply the SDK
 * assembles, settles, or when the stream fails first. The app keeps the result object it was given.
 */
export function recordGenerativeStream(
  client: EvalKitClient,
  result: unknown,
  span: Span,
  startMs: number,
  modelName: string,
): unknown {
  const r = result as { stream?: unknown; response?: unknown } | undefined;
  if (!r || typeof r !== "object") {
    endSpan(span);
    return result;
  }
  const text = new StreamText();
  const thinking = new StreamText();
  const tools = new StreamToolCalls();
  const first = new FirstToken(startMs);
  let usage: GoogleUsage = EMPTY_GOOGLE_USAGE;
  let finishReasons: string[] = [];
  let ended = false;

  const record = (error?: Error, final?: GenerativeResponse): void => {
    const whole = final ? candidateText(final) : undefined;
    const completion = whole?.completion || text.toString();
    const thought = whole?.thinking || thinking.toString();
    const finalUsage = final?.usageMetadata ? mergeGoogleUsage(usage, extractGoogleUsage(final.usageMetadata)) : usage;
    const reasons = final ? finishReasonsOf(final) : finishReasons;
    setAttributes(span, () => ({
      "gen_ai.response.model": modelName,
      ...googleUsageAttributes(finalUsage),
      ...(reasons.length > 0 && { "gen_ai.response.finish_reasons": reasons }),
      "gen_ai.streaming": true,
      "evalkit.completion": completion,
      ...(thought && { "gen_ai.response.thinking": thought }),
      ...first.attributes(error),
      "gen_ai.response.body": safeBody({ text: completion }),
    }), "recording a streamed Gemini reply");
    guarded("recording streamed Gemini tool calls", () => {
      const calls = final ? fromGoogleParts(final) : tools.calls();
      emitToolCalls(client, span, calls.length ? calls : tools.calls());
    }, undefined);
  };

  const finish = (error?: Error, final?: GenerativeResponse): void => {
    if (ended) return;
    ended = true;
    guarded("reading the whole Gemini reply", () => record(error, final), undefined);
    endSpan(span, error);
  };

  let reading = false;
  const onChunk = (chunk: GenerativeResponse): void => {
    reading = true;
    for (const cand of chunk?.candidates ?? []) {
      for (const part of cand?.content?.parts ?? []) {
        if (part?.functionCall?.name) {
          tools.add(part.functionCall.name, part.functionCall.args ?? {}, part.functionCall.id);
        } else if (part?.thought) {
          if (thinking.append(part.text)) first.mark();
        } else if (text.append(part?.text)) {
          first.mark();
        }
      }
    }
    const reasons = finishReasonsOf(chunk);
    if (reasons.length) finishReasons = reasons;
    if (chunk?.usageMetadata) usage = mergeGoogleUsage(usage, extractGoogleUsage(chunk.usageMetadata));
  };

  const hasResponse = isThenable(r.response);
  const observed = observeStream(r.stream, onChunk, (error) => {
    if (error || !hasResponse) finish(error);
  });
  if (observed !== r.stream) {
    try {
      r.stream = observed;
    } catch {
      return { ...r, stream: observed };
    }
  }
  if (hasResponse) {
    // Handlers that return, so this observation adds no rejection of its own; the app keeps its `response`.
    // A failure while the app is reading the stream is left to the stream, which keeps the text the app
    // read before it.
    (r.response as PromiseLike<unknown>).then(
      (final) => finish(undefined, final as GenerativeResponse),
      (err) => {
        if (!reading) finish(err instanceof Error ? err : new Error(String(err)));
      },
    );
  }
  return result;
}
