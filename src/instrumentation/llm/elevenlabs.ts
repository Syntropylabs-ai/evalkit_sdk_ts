import { SpanKind, SpanStatusCode, context as otelContext } from "@opentelemetry/api";
import { recordError } from '../../core/exceptions.js';
import type { EvalKitClient } from "../../core/client.js";
import { safeBody } from "./_body.js";
import { claimPatch } from "../_patched.js";

function patchConvert(client: EvalKitClient, proto: any): void {
  if (typeof proto?.convert !== "function" || proto.convert.__evalkit) return;
  if (!claimPatch(proto, "convert")) return;
  const original = proto.convert;

  async function traced(this: any, voiceId: string, body: any = {}, ...rest: any[]) {
    const model = String(body?.modelId ?? "unknown");
    const text = String(body?.text ?? "");
    const reqBody = safeBody({ ...body, text: undefined });
    const attrs: Record<string, any> = { "evalkit.span_type": "llm_call", "gen_ai.system": "elevenlabs" };
    if (text) attrs["evalkit.prompt"] = text;
    if (reqBody) attrs["gen_ai.request.body"] = reqBody;
    const span = client.tracer.startSpan("audio.speech", { kind: SpanKind.CLIENT, attributes: attrs }, otelContext.active());

    try {
      const result = await original.call(this, voiceId, body, ...rest);
      span.setAttributes({
        "evalkit.completion": "[audio generated]",
        "gen_ai.audio.input_characters": text.length,
        "gen_ai.request.voice": voiceId,
      });
      span.setStatus({ code: SpanStatusCode.OK });
      span.end();
      return result;
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      span.setAttributes({ "gen_ai.audio.input_characters": text.length, "gen_ai.request.voice": voiceId });
      recordError(span, error, { escaped: true });
      span.end();
      throw err;
    }
  }
  traced.__evalkit = true;
  proto.convert = traced;
}

export function patchElevenLabsClientInstance(client: EvalKitClient, elevenLabsClient: any): any {
  try {
    const proto = Object.getPrototypeOf(elevenLabsClient?.textToSpeech);
    if (proto) patchConvert(client, proto);
  } catch {  }
  return elevenLabsClient;
}
