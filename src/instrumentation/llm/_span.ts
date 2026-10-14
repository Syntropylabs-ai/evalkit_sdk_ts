import { SpanStatusCode } from "@opentelemetry/api";
import type { Span } from "@opentelemetry/api";
import { asError, swallow } from "../../core/guard.js";

/** Sets a model-call span's status and ends it; `error` is recorded, never thrown. */
export function endSpan(span: Span, error?: unknown): void {
  try {
    if (error !== undefined) {
      const err = asError(error);
      span.recordException(err);
      span.setStatus({ code: SpanStatusCode.ERROR, message: err.message });
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

/** Sets attributes on a span, swallowing what a value the caller supplied makes them throw. */
export function setAttributes(span: Span, build: () => Record<string, unknown>, where: string): void {
  try {
    const attrs = build();
    for (const [key, value] of Object.entries(attrs)) {
      if (value !== undefined && value !== null) span.setAttribute(key, value as never);
    }
  } catch (err) {
    swallow(where, err);
  }
}
