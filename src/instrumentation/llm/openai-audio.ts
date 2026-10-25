import { SpanKind, SpanStatusCode, context as otelContext } from "@opentelemetry/api";
import { recordError } from '../../core/exceptions.js';
import type { EvalKitClient } from "../../core/client.js";
import { safeBody } from "./_body.js";
import { claimPatch } from "../_patched.js";

function startAudioSpan(client: EvalKitClient, operation: string, model: string, prompt: string, reqBody?: string) {
  const attrs: Record<string, any> = { "evalkit.span_type": "llm_call", "gen_ai.system": "openai" };
  if (prompt) attrs["evalkit.prompt"] = prompt;
  if (reqBody) attrs["gen_ai.request.body"] = reqBody;
  const span = client.tracer.startSpan(operation, { kind: SpanKind.CLIENT, attributes: attrs }, otelContext.active());

  return (status: "OK" | "ERROR", opts: { completion?: string; extra?: Record<string, any>; err?: unknown } = {}) => {
    try {
      if (opts.completion) span.setAttribute("evalkit.completion", opts.completion);
      if (opts.extra) span.setAttributes(opts.extra);
      if (opts.err) {
        const error = opts.err instanceof Error ? opts.err : new Error(String(opts.err));
        recordError(span, error, { escaped: true });
      } else {
        span.setStatus({ code: status === "OK" ? SpanStatusCode.OK : SpanStatusCode.ERROR });
      }
      span.end();
    } catch {  }
  };
}

function patchSpeech(client: EvalKitClient, Speech: any): void {
  if (typeof Speech?.prototype?.create !== "function" || Speech.prototype.create.__evalkit) return;
  if (!claimPatch(Speech.prototype, "create")) return;
  const original = Speech.prototype.create;

  async function traced(this: any, body: any = {}, ...rest: any[]) {
    const model = String(body?.model ?? "unknown");
    const input = String(body?.input ?? "");
    const reqBody = safeBody({ ...body, input: undefined });
    const end = startAudioSpan(client, "audio.speech", model, input, reqBody);
    const extra = { "gen_ai.audio.input_characters": input.length, "gen_ai.request.voice": String(body?.voice ?? "") };
    try {
      const result = await original.call(this, body, ...rest);
      end("OK", { completion: "[audio generated]", extra });
      return result;
    } catch (err) {
      end("ERROR", { err, extra });
      throw err;
    }
  }
  traced.__evalkit = true;
  Speech.prototype.create = traced;
}

function extractTranscriptionUsage(response: any): { extra: Record<string, any>; tokensIn?: number; tokensOut?: number } {
  const extra: Record<string, any> = {};
  let tokensIn: number | undefined;
  let tokensOut: number | undefined;
  try {
    const usage = response?.usage;
    if (usage?.type === "duration" && typeof usage.seconds === "number") {
      extra["gen_ai.audio.duration_seconds"] = usage.seconds;
    } else if (usage?.type === "tokens") {
      tokensIn = usage.input_tokens;
      tokensOut = usage.output_tokens;
      const audioTokens = usage.input_token_details?.audio_tokens;
      if (audioTokens) extra["gen_ai.usage.audio_input_tokens"] = audioTokens;
    }
    if (typeof response?.duration === "number") extra["gen_ai.audio.duration_seconds"] = response.duration;
  } catch {  }
  return { extra, tokensIn, tokensOut };
}

function transcriptionText(response: any): string {
  if (typeof response === "string") return response;
  return String(response?.text ?? "");
}

function patchTranscribe(client: EvalKitClient, Cls: any, operation: string): void {
  if (typeof Cls?.prototype?.create !== "function" || Cls.prototype.create.__evalkit) return;
  if (!claimPatch(Cls.prototype, "create")) return;
  const original = Cls.prototype.create;

  async function traced(this: any, body: any = {}, ...rest: any[]) {
    const model = String(body?.model ?? "unknown");
    const fileName = body?.file?.name ?? "audio file";
    const reqBody = safeBody({ ...body, file: undefined });

    if (body?.stream) return original.call(this, body, ...rest);

    const end = startAudioSpan(client, operation, model, `[${fileName}]`, reqBody);
    try {
      const result = await original.call(this, body, ...rest);
      const usage = extractTranscriptionUsage(result);
      const respBody = typeof result !== "string" ? safeBody(result) : undefined;
      if (respBody) usage.extra["gen_ai.response.body"] = respBody;
      end("OK", {
        completion: transcriptionText(result),
        extra: { ...usage.extra, "gen_ai.usage.input_tokens": usage.tokensIn, "gen_ai.usage.output_tokens": usage.tokensOut },
      });
      return result;
    } catch (err) {
      end("ERROR", { err });
      throw err;
    }
  }
  traced.__evalkit = true;
  Cls.prototype.create = traced;
}

export function patchOpenAIAudio(client: EvalKitClient, OpenAIClass: any): void {
  const audio = OpenAIClass?.Audio;
  try {
    if (audio?.Speech) patchSpeech(client, audio.Speech);
  } catch {  }
  try {
    if (audio?.Transcriptions) patchTranscribe(client, audio.Transcriptions, "audio.transcription");
  } catch {  }
  try {
    if (audio?.Translations) patchTranscribe(client, audio.Translations, "audio.translation");
  } catch {  }
}
