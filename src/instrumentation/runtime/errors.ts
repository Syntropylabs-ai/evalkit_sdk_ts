import { trace, context as otelContext, SpanKind, SpanStatusCode } from '@opentelemetry/api';
import type { EvalKitClient } from '../../core/client.js';
import { errorAttrs } from '../../core/errors-util.js';

let _installed = false;

function emitErrorSpan(client: EvalKitClient, eventName: string, error: Error): void {
  try {

    const attrs = {
      ...errorAttrs(error),
      'log.level': 'ERROR',
      'log.message': `${eventName}: ${error.message}`,
    };
    const active = trace.getActiveSpan();
    if (active?.isRecording()) {
      active.addEvent(eventName, attrs);
      active.recordException(error);
      active.setStatus({ code: SpanStatusCode.ERROR, message: error.message });
    } else {
      const span = client.tracer.startSpan(eventName, {
        kind: SpanKind.INTERNAL,
        attributes: { 'evalkit.span_type': 'log', ...attrs },
      }, otelContext.active());
      span.recordException(error);
      span.setStatus({ code: SpanStatusCode.ERROR, message: error.message });
      span.end();
    }
  } catch {  }
}

export function patchErrors(client: EvalKitClient): void {
  if (typeof process === 'undefined') return;
  if (!client.options.captureGlobalErrors) return;
  if (_installed) return;
  _installed = true;

  // Installed once per process; a later init() that turns capture off silences them, but the exit an
  // uncaught exception owes the process stays.
  process.on('unhandledRejection', (reason: unknown) => {
    if (!client.options.captureGlobalErrors) return;
    emitErrorSpan(client, 'error.unhandled_rejection', reason instanceof Error ? reason : new Error(String(reason)));
  });

  process.prependListener('uncaughtException', (err: Error) => {
    if (client.options.captureGlobalErrors) {
      emitErrorSpan(client, 'error.uncaught_exception', err instanceof Error ? err : new Error(String(err)));
    }
    if (process.listenerCount('uncaughtException') === 1) {
      setImmediate(() => process.exit(1));
    }
  });
}
