import { SpanKind, SpanStatusCode, context as otelContext } from "@opentelemetry/api";
import type { EvalKitClient } from "../../core/client.js";
import { safeBody } from "./_body.js";

// Patch AssemblyAI's TranscriptService.transcribe at the class level.
//
// Billed by audio duration, not tokens — cost is proportional to
// response.audio_duration (seconds), NOT the length of response.audio_url. A
// shared helper in OpenLit's own Python SDK conflates the two (treats any
// non-empty "prompt"-like string as character-billed), silently pricing
// AssemblyAI transcripts off the URL string length instead of actual audio
// duration — confirmed by reading their real source. We use audio_duration
// only.
//
// AssemblyAI doesn't reject on the promise for a failed transcription — a
// failed job resolves with a normal Transcript that has `.error` set (and
// `.status === "error"`), not a rejection — so success/failure is read off
// the response, not just a try/catch.
//
// Degrades to a no-op if `assemblyai` isn't installed and never throws into
// the caller.

export function patchAssemblyAI(client: EvalKitClient, TranscriptService: any): void {
  if (typeof TranscriptService?.prototype?.transcribe !== "function" || TranscriptService.prototype.transcribe.__evalkit) return;
  const original = TranscriptService.prototype.transcribe;

  async function traced(this: any, params: any = {}, ...rest: any[]) {
    const model = String(params?.speech_model ?? "best");
    const source = typeof params?.audio === "string" ? params.audio : (params?.audio_url ?? "audio file");
    const reqBody = safeBody({ speech_model: model });
    const attrs: Record<string, any> = { "evalkit.span_type": "llm_call", "gen_ai.system": "assemblyai" };
    attrs["evalkit.prompt"] = `[${source}]`;
    if (reqBody) attrs["gen_ai.request.body"] = reqBody;
    const span = client.tracer.startSpan("audio.transcription", { kind: SpanKind.CLIENT, attributes: attrs }, otelContext.active());

    let result: any;
    try {
      result = await original.call(this, params, ...rest);
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      span.recordException(error);
      span.setStatus({ code: SpanStatusCode.ERROR, message: error.message });
      span.end();
      throw err;
    }

    if (result?.error) {
      span.setAttribute("error.message", String(result.error));
      span.setStatus({ code: SpanStatusCode.ERROR, message: String(result.error) });
      span.end();
      return result;
    }

    if (result?.text) span.setAttribute("evalkit.completion", String(result.text));
    if (typeof result?.audio_duration === "number") span.setAttribute("gen_ai.audio.duration_seconds", result.audio_duration);
    span.setStatus({ code: SpanStatusCode.OK });
    span.end();
    return result;
  }
  traced.__evalkit = true;
  TranscriptService.prototype.transcribe = traced;
}
