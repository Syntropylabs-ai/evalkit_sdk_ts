import { trace, context as otelContext, SpanKind, SpanStatusCode } from '@opentelemetry/api';
import type { EvalKitClient } from '../../core/client.js';

export function patchConsole(client: EvalKitClient): void {
  if ((console as any).__evalkit) return;

  const origLog = console.log.bind(console);
  const origWarn = console.warn.bind(console);
  const origError = console.error.bind(console);

  const toMsg = (args: unknown[]): string =>
    args.map((a) => {
      if (typeof a === 'string') return a;
      if (a instanceof Error) return `${a.message}\n${a.stack ?? ''}`;
      try { return JSON.stringify(a); } catch { return String(a); }
    }).join(' ').slice(0, 2000);

  const addLogEvent = (level: string, msg: string): void => {
    const active = trace.getActiveSpan();
    if (active?.isRecording()) {
      // Attach as a span event — visible in the trace waterfall
      active.addEvent(`log.${level}`, { 'log.level': level, 'log.message': msg });
    } else {
      // Background task or no active context — create a standalone log span
      // so the log still appears in the trace service even after the parent span ended.
      const span = client.tracer.startSpan(`log.${level}`, {
        kind: SpanKind.INTERNAL,
        attributes: {
          'evalkit.span_type': 'log',
          'log.level': level,
          'log.message': msg,
        },
      }, otelContext.active());
      span.setStatus({ code: level === 'ERROR' ? SpanStatusCode.ERROR : SpanStatusCode.OK });
      span.end();
    }
  };

  console.log = (...args: unknown[]) => {
    origLog(...args);
    addLogEvent('INFO', toMsg(args));
  };

  console.warn = (...args: unknown[]) => {
    origWarn(...args);
    addLogEvent('WARN', toMsg(args));
  };

  console.error = (...args: unknown[]) => {
    origError(...args);
    addLogEvent('ERROR', toMsg(args));
  };

  (console as any).__evalkit = true;
}
