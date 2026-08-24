import { ROOT_CONTEXT, trace, context as otelContext } from "@opentelemetry/api";
import type { Context as OtelContext } from "@opentelemetry/api";

export function extractTraceparent(header: string | undefined): OtelContext {
  if (!header) return otelContext.active();
  const parts = header.split('-');
  if (
    parts.length === 4 &&
    parts[0] === '00' &&
    parts[1].length === 32 &&
    parts[2].length === 16
  ) {
    return trace.setSpanContext(ROOT_CONTEXT, {
      traceId: parts[1],
      spanId: parts[2],
      traceFlags: parseInt(parts[3], 16),
      isRemote: true,
    });
  }
  return otelContext.active();
}
