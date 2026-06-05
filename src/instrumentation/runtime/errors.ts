import { trace, SpanStatusCode } from '@opentelemetry/api';

export function patchErrors(): void {
  if (typeof process === 'undefined') return;

  process.on('unhandledRejection', (reason: unknown) => {
    const active = trace.getActiveSpan();
    if (!active?.isRecording()) return;
    const error = reason instanceof Error ? reason : new Error(String(reason));
    active.addEvent('error.unhandled_rejection', {
      'error.message': error.message,
      'error.stack': error.stack ?? '',
      'log.level': 'ERROR',
      'log.message': `UnhandledRejection: ${error.message}`,
    });
    active.recordException(error);
    active.setStatus({ code: SpanStatusCode.ERROR, message: error.message });
  });

  process.on('uncaughtException', (err: Error) => {
    const active = trace.getActiveSpan();
    if (!active?.isRecording()) return;
    active.addEvent('error.uncaught_exception', {
      'error.message': err.message,
      'error.stack': err.stack ?? '',
      'log.level': 'ERROR',
      'log.message': `UncaughtException: ${err.message}`,
    });
    active.recordException(err);
    active.setStatus({ code: SpanStatusCode.ERROR, message: err.message });
  });
}
