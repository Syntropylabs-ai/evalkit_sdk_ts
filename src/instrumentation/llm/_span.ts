import { SpanStatusCode } from "@opentelemetry/api";
import type { Span } from "@opentelemetry/api";
import { swallow } from "../../core/guard.js";
import { recordError } from "../../core/exceptions.js";

/**
 * Sets a model-call span's status and ends it; `error` is recorded by the exception contract, never thrown.
 * The provider's error reaches the app, so it escaped the span.
 */
export function endSpan(span: Span, error?: unknown): void {
  try {
    if (error !== undefined) {
      recordError(span, error, { escaped: true });
    } else {
      span.setStatus({ code: SpanStatusCode.OK });
    }
  } catch (hookErr) {
    swallow("setting a span's status", hookErr);
  }
  try {
    span.end();
  } catch (hookErr) {
    swallow("ending a span", hookErr);
  }
}

/**
 * Sets attributes on a span, swallowing what a value the caller supplied makes them throw. A span that is not
 * recording (sampled out) never builds them, so serialising a request body costs it nothing.
 */
export function setAttributes(span: Span, build: () => Record<string, unknown>, where: string): void {
  try {
    if (typeof span.isRecording === "function" && !span.isRecording()) return;
    const attrs = build();
    for (const [key, value] of Object.entries(attrs)) {
      if (value !== undefined && value !== null) span.setAttribute(key, value as never);
    }
  } catch (err) {
    swallow(where, err);
  }
}
