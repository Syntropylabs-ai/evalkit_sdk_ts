import { trace, context as otelContext, SpanKind, SpanStatusCode } from '@opentelemetry/api';
import type { EvalKitClient } from '../../core/client.js';

function emitErrorSpan(client: EvalKitClient, eventName: string, error: Error): void {
  // Attach to the active span if one is recording; otherwise create a standalone
  // root span so background errors are never silently dropped.
  const active = trace.getActiveSpan();
  if (active?.isRecording()) {
    active.addEvent(eventName, {
      'error.message': error.message,
      'error.stack': error.stack ?? '',
      'log.level': 'ERROR',
      'log.message': `${eventName}: ${error.message}`,
    });
    active.recordException(error);
    active.setStatus({ code: SpanStatusCode.ERROR, message: error.message });
  } else {
    const span = client.tracer.startSpan(eventName, {
      kind: SpanKind.INTERNAL,
      attributes: {
        'evalkit.span_type': 'log',
        'log.level': 'ERROR',
        'log.message': `${eventName}: ${error.message}`,
        'error.message': error.message,
        'error.stack': error.stack ?? '',
      },
    }, otelContext.active());
    span.recordException(error);
    span.setStatus({ code: SpanStatusCode.ERROR, message: error.message });
    span.end();
  }
}

export function patchErrors(client: EvalKitClient): void {
  if (typeof process === 'undefined') return;

  process.on('unhandledRejection', (reason: unknown) => {
    const error = reason instanceof Error ? reason : new Error(String(reason));
    emitErrorSpan(client, 'error.unhandled_rejection', error);
  });

  process.on('uncaughtException', (err: Error) => {
    emitErrorSpan(client, 'error.uncaught_exception', err instanceof Error ? err : new Error(String(err)));
  });
}
