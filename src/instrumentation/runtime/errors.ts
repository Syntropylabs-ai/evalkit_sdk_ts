import { trace, SpanStatusCode } from '@opentelemetry/api';

export function patchErrors(): void {
  if (typeof process === 'undefined') return;

  process.on('unhandledRejection', (reason: unknown) => {
    const active = trace.getActiveSpan();
    if (!active?.isRecording()) return;
    const msg = reason instanceof Error ? reason.message : String(reason);
    const stack = reason instanceof Error ? (reason.stack ?? '') : '';
    active.addEvent('error.unhandled_rejection', {
      'error.message': msg,
      'error.stack': stack,
      'log.level': 'ERROR',
      'log.message': `UnhandledRejection: ${msg}`,
    });
    active.setStatus({ code: SpanStatusCode.ERROR, message: msg });
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
    active.setStatus({ code: SpanStatusCode.ERROR, message: err.message });
  });
}
