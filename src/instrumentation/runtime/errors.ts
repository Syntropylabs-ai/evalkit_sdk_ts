import { trace, context as otelContext, SpanKind } from '@opentelemetry/api';
import type { EvalKitClient } from '../../core/client.js';
import { exceptionType, recordError } from '../../core/exceptions.js';
import { cutEnd } from '../../core/truncate.js';
import { safeString } from '../../core/serialize.js';

let _installed = false;

function messageOf(error: unknown): string {
  try {
    const message = error instanceof Error ? error.message : safeString(error);
    return cutEnd(message, 2048);
  } catch {
    return '';
  }
}

// An uncaught exception or unhandled rejection escaped everything the app had; it is recorded on the span
// active where it surfaced, or as a span of its own.
function emitErrorSpan(client: EvalKitClient, eventName: string, error: unknown): void {
  try {
    const attrs = {
      'log.level': 'ERROR',
      'log.message': `${eventName}: ${exceptionType(error)}: ${messageOf(error)}`,
    };
    const active = trace.getActiveSpan();
    if (active?.isRecording()) {
      active.addEvent(eventName, attrs);
      recordError(active, error, { escaped: true });
    } else {
      const span = client.tracer.startSpan(eventName, {
        kind: SpanKind.INTERNAL,
        attributes: { 'evalkit.span_type': 'log', ...attrs },
      }, otelContext.active());
      recordError(span, error, { escaped: true });
      span.end();
    }
  } catch {  }
}

// How Node treats a rejection nobody handles (--unhandled-rejections): "throw" by default since Node 15.
function rejectionMode(): string {
  try {
    const flags = [...(process.execArgv ?? []), ...String(process.env.NODE_OPTIONS ?? '').split(/\s+/)];
    for (const flag of flags) {
      const m = /^--unhandled-rejections=(\S+)$/.exec(flag);
      if (m) return m[1];
    }
  } catch {
    // The default below.
  }
  return 'throw';
}

const raised = new WeakSet<object>();

function exitAfterFlush(client: EvalKitClient, error: unknown): void {
  // With a listener installed Node neither prints the error nor exits; both happen as they would without
  // one, once the error's span had up to two seconds to be sent.
  try {
    const text = error instanceof Error && typeof error.stack === 'string' ? error.stack : safeString(error);
    process.stderr.write(`${text}\n`);
  } catch {  }
  let exited = false;
  const exit = () => {
    if (exited) return;
    exited = true;
    process.exit(1);
  };
  const guard = setTimeout(exit, 2500);
  (guard as { unref?: () => void }).unref?.();
  try {
    client.flush(2000).then(exit, exit);
  } catch {
    setImmediate(exit);
  }
}

/**
 * Records uncaught exceptions and unhandled rejections (opt-in: captureGlobalErrors). The process goes on as
 * it would without the SDK: an uncaught exception the app has no handler for is printed and exits with code
 * 1, and an unhandled rejection is raised as one under Node's default --unhandled-rejections=throw.
 */
export function patchErrors(client: EvalKitClient): void {
  if (typeof process === 'undefined') return;
  if (!client.options.captureGlobalErrors) return;
  if (_installed) return;
  _installed = true;

  // Installed once per process; a later init() that turns capture off silences them, but the exit an
  // uncaught exception owes the process stays.
  const onRejection = (reason: unknown): void => {
    if (client.options.captureGlobalErrors) {
      emitErrorSpan(client, 'error.unhandled_rejection', reason);
      if (reason && typeof reason === 'object') raised.add(reason);
    }
    let others = 0;
    try {
      others = process.listeners('unhandledRejection').filter((l) => l !== onRejection).length;
    } catch {  }
    if (others > 0) return;
    const mode = rejectionMode();
    if (mode === 'warn-with-error-code') {
      // As Node does when no listener is set: a warning, and exit code 1 when the process ends.
      try {
        const text = reason instanceof Error && typeof reason.stack === 'string' ? reason.stack : safeString(reason);
        process.emitWarning(text, 'UnhandledPromiseRejectionWarning');
        process.exitCode = 1;
      } catch {  }
      return;
    }
    if (mode !== 'throw') return;
    const error = reason instanceof Error
      ? reason
      : Object.assign(
        new Error(
          'This error originated either by throwing inside of an async function without a catch block, or by ' +
            `rejecting a promise which was not handled with .catch(). The promise rejected with the reason "${safeString(reason)}".`,
        ),
        { code: 'ERR_UNHANDLED_REJECTION' },
      );
    if (error !== reason && error && typeof error === 'object') raised.add(error);
    process.nextTick(() => {
      throw error;
    });
  };
  process.on('unhandledRejection', onRejection);

  const onUncaught = (err: Error): void => {
    if (client.options.captureGlobalErrors && !(err && typeof err === 'object' && raised.has(err))) {
      emitErrorSpan(client, 'error.uncaught_exception', err);
    }
    let others = 0;
    try {
      others = process.listeners('uncaughtException').filter((l) => l !== onUncaught).length;
    } catch {  }
    if (others === 0) exitAfterFlush(client, err);
  };
  process.prependListener('uncaughtException', onUncaught);
}
