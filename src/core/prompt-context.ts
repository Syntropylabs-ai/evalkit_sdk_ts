import { context as otelContext, createContextKey, trace } from "@opentelemetry/api";
import type { Context as OtelContext, Span } from "@opentelemetry/api";

export interface PromptRef {
  name: string;
  version: number;
}

export const PROMPT_CONTEXT_KEY = createContextKey("evalkit.prompt");

export function promptAttributes(ref: PromptRef): Record<string, string | number> {
  return { "prompt.ref": `${ref.name}@${ref.version}`, "prompt.name": ref.name, "prompt.version": ref.version };
}

export function activePromptRef(ctx: OtelContext = otelContext.active()): PromptRef | undefined {
  const value = ctx.getValue(PROMPT_CONTEXT_KEY);
  return value && typeof value === "object" ? (value as PromptRef) : undefined;
}

export function withPromptRef<T>(ref: PromptRef, fn: () => T): T {
  return otelContext.with(otelContext.active().setValue(PROMPT_CONTEXT_KEY, ref), fn);
}

export function stampSpan(span: Span | undefined, ref: PromptRef): boolean {
  if (!span || !span.isRecording()) return false;
  span.setAttributes(promptAttributes(ref));
  return true;
}

export function stampActiveSpan(ref: PromptRef): boolean {
  return stampSpan(trace.getActiveSpan(), ref);
}
