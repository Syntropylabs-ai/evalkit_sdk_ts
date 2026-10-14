import type { Context as OtelContext } from "@opentelemetry/api";
import type { EvalKitClient } from "../../../core/client.js";
import { patchAnthropic } from "../anthropic/index.js";
import { patchGenerativeModel } from "../google-ai/index.js";

type AnthropicMessages = { create: (...args: unknown[]) => unknown };

export function patchAnthropicVertex(
  client: EvalKitClient,
  messages: AnthropicMessages,
  parentCtx?: OtelContext
): void {
  patchAnthropic(client, messages, parentCtx);
}

type GenerativeModel = {
  generateContent?: (...args: unknown[]) => unknown;
  generateContentStream?: (...args: unknown[]) => unknown;
  model?: string;
};

export function patchVertexGenerativeModel(
  client: EvalKitClient,
  model: GenerativeModel,
  parentCtx?: OtelContext
): void {
  patchGenerativeModel(client, model, { system: 'google-vertex', parentCtx });
}
