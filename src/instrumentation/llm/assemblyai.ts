import { SpanKind, SpanStatusCode, context as otelContext } from "@opentelemetry/api";
import { recordError } from '../../core/exceptions.js';
import type { EvalKitClient } from "../../core/client.js";
import { safeBody } from "./_body.js";
import { claimPatch } from "../_patched.js";

export function patchAssemblyAI(client: EvalKitClient, TranscriptService: any): void {
  if (typeof TranscriptService?.prototype?.transcribe !== "function" || TranscriptService.prototype.transcribe.__evalkit) return;
  if (!claimPatch(TranscriptService.prototype, "transcribe")) return;
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
      recordError(span, error, { escaped: true });
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
