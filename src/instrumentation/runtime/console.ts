import { trace, context as otelContext, SpanKind, SpanStatusCode } from '@opentelemetry/api';
import type { EvalKitClient } from '../../core/client.js';
import type { ConsoleSpanLevel } from '../../core/types.js';
import { boundedJson, safeString } from '../../core/serialize.js';
import { tracingSuppressed } from '../../core/suppress.js';

/** The most of one console call recorded. */
export const LOG_MESSAGE_MAX = 2000;

// The most console calls recorded per second; the rest are written to the console as always and not
// recorded. An app that logs in a tight loop then pays almost nothing for the SDK.
const LOGS_PER_SECOND = 50;

type Level = 'INFO' | 'WARN' | 'ERROR';

const RANK: Record<Level, number> = { INFO: 0, WARN: 1, ERROR: 2 };
const THRESHOLD: Record<ConsoleSpanLevel, number> = { info: 0, warn: 1, error: 2, none: 3 };

function errorText(error: Error, room: number): string {
  let head: string;
  try {
    head = `${error.message}`;
  } catch {
    head = '';
  }
  if (head.length >= room) return head.slice(0, room);
  let stack = '';
  try {
    stack = typeof error.stack === 'string' ? error.stack : '';
  } catch {
    stack = '';
  }
  return `${head}\n${stack.slice(0, room)}`;
}

/** What one argument contributes, within `room` characters, without reading more of it than that. */
function argText(arg: unknown, room: number): string {
  try {
    if (typeof arg === 'string') return arg.length > room ? arg.slice(0, room) : arg;
    if (arg instanceof Error) return errorText(arg, room);
    const json = boundedJson(arg, room);
    if (json) return json.text;
  } catch {
    // Written below as its string form.
  }
  const s = safeString(arg);
  return s.length > room ? s.slice(0, room) : s;
}

/** The console call's text, at most LOG_MESSAGE_MAX characters, never throwing. */
export function consoleMessage(args: unknown[], max: number = LOG_MESSAGE_MAX): string {
  let out = '';
  for (let i = 0; i < args.length; i++) {
    const room = max - out.length - (i > 0 ? 1 : 0);
    if (room <= 0) break;
    out += (i > 0 ? ' ' : '') + argText(args[i], room);
  }
  return out.length > max ? out.slice(0, max) : out;
}

export function patchConsole(client: EvalKitClient): void {
  if ((console as any).__evalkit) return;

  const origLog = console.log.bind(console);
  const origWarn = console.warn.bind(console);
  const origError = console.error.bind(console);

  let windowStart = 0;
  let inWindow = 0;
  let recording = false;

  const allowed = (): boolean => {
    const now = Date.now();
    if (now - windowStart >= 1000) {
      windowStart = now;
      inWindow = 0;
    }
    if (inWindow >= LOGS_PER_SECOND) return false;
    inWindow++;
    return true;
  };

  const addLogEvent = (level: Level, args: unknown[]): void => {
    // A log line the SDK writes, or one written while a log is being recorded, is never recorded itself.
    if (recording) return;
    recording = true;
    try {
      const options = client.options;
      if (options.captureConsole === false) return;
      if (typeof args[0] === 'string' && args[0].startsWith('[evalkit]')) return;
      // Inside an untraced scope a log line is written as always and recorded nowhere, not even as an
      // event on the span around the scope.
      if (tracingSuppressed()) return;
      const active = trace.getActiveSpan();
      const recordingSpan = !!active?.isRecording();
      const standalone = !recordingSpan && RANK[level] >= THRESHOLD[options.consoleSpanLevel ?? 'warn'];
      if (!recordingSpan && !standalone) return;
      if (!allowed()) return;
      const msg = consoleMessage(args);
      if (recordingSpan) {
        active!.addEvent(`log.${level}`, { 'log.level': level, 'log.message': msg });
        return;
      }
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
    } catch {
      // Recording a log line never fails the call that wrote it.
    } finally {
      recording = false;
    }
  };

  console.log = (...args: unknown[]) => {
    origLog(...args);
    addLogEvent('INFO', args);
  };

  console.warn = (...args: unknown[]) => {
    origWarn(...args);
    addLogEvent('WARN', args);
  };

  console.error = (...args: unknown[]) => {
    origError(...args);
    addLogEvent('ERROR', args);
  };

  (console as any).__evalkit = true;
}
