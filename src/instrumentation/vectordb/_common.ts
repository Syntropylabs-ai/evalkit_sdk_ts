import { SpanKind, SpanStatusCode, context as otelContext } from "@opentelemetry/api";
import { recordError } from '../../core/exceptions.js';
import type { EvalKitClient } from "../../core/client.js";

export { safeBody } from "../llm/_body.js";

export function startVectorDb(
  client: EvalKitClient,
  system: string,
  operation: string,
  name?: string,
): (status: "OK" | "ERROR", attrs?: Record<string, string | number | boolean>, err?: unknown) => void {
  const span = client.tracer.startSpan(
    name ?? `${system} ${operation}`,
    {
      kind: SpanKind.CLIENT,
      attributes: {
        "evalkit.span_type": "db_query",
        "db.system": system,
        "db.operation": operation,
      },
    },
    otelContext.active(),
  );

  return (status, attrs, err) => {
    try {
      if (attrs) span.setAttributes(attrs);
      if (err) {
        const error = err instanceof Error ? err : new Error(String(err));
        recordError(span, error, { escaped: true });
      } else {
        span.setStatus({ code: status === "OK" ? SpanStatusCode.OK : SpanStatusCode.ERROR });
      }
      span.end();
    } catch {  }
  };
}
