import * as http from 'http';
import { hasRecordedError, recordError } from '../../core/exceptions.js';
import * as https from 'https';
import { trace, context as otelContext, SpanKind, SpanStatusCode } from '@opentelemetry/api';
import type { Span } from '@opentelemetry/api';
import type { EvalKitClient } from '../../core/client.js';
import { requireBuiltin } from '../../utils/dynimport.js';
import { sanitizeHeaders } from '../../utils/headers.js';
import { _evalkitAxiosSpanMap } from '../../utils/axios-span-map.js';
import { clientSpanName, markServerSpan, serverError, serverName, serverRoute } from '../../utils/http-route.js';
import { isServerErrorStatus } from '../../core/http-status.js';
import { isIgnoredRequest, isIgnoredUrl } from '../../core/ignore.js';
import { suppressedContext, tracingSuppressed } from '../../core/suppress.js';
import { claimPatch } from '../_patched.js';
import { swallow } from '../../core/guard.js';

const SKIP_PATTERNS = [
  /\/v1\/ingest/,
  /169\.254\./,
  /metadata\.google/,
  /storage\.googleapis/,
];

// Calls that are never the app's own: the export itself, and the cloud metadata and storage endpoints the
// runtime polls.
function isPlumbing(url: string): boolean {
  return SKIP_PATTERNS.some((p) => p.test(url));
}

/** An outgoing call recorded as nothing at all: no span, and no traceparent sent with it. */
function shouldSkip(url: string, method?: string): boolean {
  return isPlumbing(url) || isIgnoredUrl(url, method) || tracingSuppressed();
}

function extractUrlMethod(
  input: string | URL | http.RequestOptions,
  secondArg: http.RequestOptions | undefined,
  scheme: string,
): { url: string; method: string } {
  let url = '';
  let method = 'GET';

  if (typeof input === 'string') {
    url = input;
    method = (secondArg?.method ?? 'GET').toUpperCase();
  } else if (input instanceof URL) {
    url = input.href;
    method = (secondArg?.method ?? 'GET').toUpperCase();
  } else {
    const host = input.hostname ?? input.host ?? 'localhost';
    const port = input.port ? `:${input.port}` : '';
    const path = input.path ?? '/';
    url = `${scheme}://${host}${port}${path}`;
    method = (input.method ?? secondArg?.method ?? 'GET').toUpperCase();
  }

  return { url, method };
}

export function patchHttp(client: EvalKitClient): void {

  let httpMod: typeof http;
  let httpsMod: typeof https;
  try {
    httpMod = requireBuiltin<typeof http>('http');
    httpsMod = requireBuiltin<typeof https>('https');
  } catch {
    return;
  }

  const mods: Array<{ mod: typeof http; scheme: string }> = [
    { mod: httpMod, scheme: 'http' },
    { mod: httpsMod as unknown as typeof http, scheme: 'https' },
  ];

  for (const { mod, scheme } of mods) {
    const orig = (mod as any).request as Function;
    if ((orig as any).__evalkit || !claimPatch(mod, 'request')) continue;

    // The SDK's work around the request is guarded: when it fails the request is made as if the SDK were not
    // there, and an error the request itself raises reaches the app once, as raised.
    function evalkitTracedRequest(
      input: string | URL | http.RequestOptions,
      optionsOrCallback?: http.RequestOptions | ((res: http.IncomingMessage) => void),
      callback?: (res: http.IncomingMessage) => void,
    ): http.ClientRequest {
      let called = false;
      const callOriginal = (): http.ClientRequest => {
        called = true;
        return orig.call(mod, input, optionsOrCallback, callback);
      };
      try {
        return tracedRequest(input, optionsOrCallback, callOriginal);
      } catch (err) {
        if (called) throw err;
        swallow('tracing an outgoing request', err);
        return orig.call(mod, input, optionsOrCallback, callback);
      }
    }

    function tracedRequest(
      input: string | URL | http.RequestOptions,
      optionsOrCallback: http.RequestOptions | ((res: http.IncomingMessage) => void) | undefined,
      callOriginal: () => http.ClientRequest,
    ): http.ClientRequest {
      const options = typeof optionsOrCallback === 'function' ? undefined : optionsOrCallback;
      const { url, method } = extractUrlMethod(input, options, scheme);

      if (shouldSkip(url, method)) {
        return callOriginal();
      }

      const activeSpan = trace.getActiveSpan();
      if (!activeSpan?.isRecording()) {
        return callOriginal();
      }

      const reqHeaders: Record<string, string | string[] | undefined> = {
        ...(typeof input === 'object' && !(input instanceof URL)
          ? (input as http.RequestOptions).headers as Record<string, string | string[] | undefined> ?? {}
          : {}),
        ...(options?.headers as Record<string, string | string[] | undefined> ?? {}),
      };

      const axiosSpanId = reqHeaders['x-evalkit-span-id'];
      if (axiosSpanId) {
        if (typeof input === 'object' && !(input instanceof URL) && (input as any).headers) {
          delete (input as any).headers['x-evalkit-span-id'];
        }
        if (options?.headers) delete (options.headers as any)['x-evalkit-span-id'];

        const axiosSpan = _evalkitAxiosSpanMap.get(String(axiosSpanId));
        if (axiosSpan) {
          const fullHeaders = sanitizeHeaders({ ...reqHeaders });
          delete fullHeaders['x-evalkit-span-id'];
          if (Object.keys(fullHeaders).length) {
            axiosSpan.setAttributes({ 'http.request.headers': JSON.stringify(fullHeaders) });
          }
        }
        return callOriginal();
      }

      const sanitized = sanitizeHeaders(reqHeaders);

      const span = client.tracer.startSpan(clientSpanName(method), {
        kind: SpanKind.CLIENT,
        attributes: {
          'evalkit.span_type': 'http_call',
          'http.method': method,
          'http.url': url,
          ...(Object.keys(sanitized).length
            ? { 'http.request.headers': JSON.stringify(sanitized) }
            : {}),
        },
      }, otelContext.active());

      const req: http.ClientRequest = callOriginal();

      const spanCtx = span.spanContext();
      try { req.setHeader('traceparent', `00-${spanCtx.traceId}-${spanCtx.spanId}-01`); } catch {  }

      observeClientRequest(req, span);
      return req;
    }

    (evalkitTracedRequest as any).__evalkit = true;
    Object.defineProperty(mod, 'request', {
      value: evalkitTracedRequest,
      writable: true,
      configurable: true,
    });
  }
}

/**
 * Ends an outgoing request's span from the events the request emits, through a wrapped `emit` rather than
 * listeners of its own: a 'response' listener would keep Node from discarding a response the app ignores,
 * which holds its socket, and an 'error' listener would swallow an error that has no handler of the app's.
 */
function observeClientRequest(req: http.ClientRequest, span: Span): void {
  let ended = false;
  try {
    const originalEmit = req.emit;
    req.emit = function (this: http.ClientRequest, event: string | symbol, ...args: any[]): boolean {
      if (!ended && (event === 'response' || event === 'error')) {
        ended = true;
        try {
          if (event === 'response') {
            const res = args[0] as http.IncomingMessage;
            const sc = res?.statusCode ?? 0;
            span.setAttributes({
              'http.status_code': sc,
              ...(res?.headers ? { 'http.response.headers': JSON.stringify(sanitizeHeaders(res.headers as any)) } : {}),
            });
            span.setStatus({ code: sc >= 400 ? SpanStatusCode.ERROR : SpanStatusCode.OK });
          } else {
            const err = args[0];
            span.setAttribute('http.status_code', 0);
            recordError(span, err, { escaped: true });
          }
          span.end();
        } catch {  }
      }
      return originalEmit.call(this, event, ...args);
    } as typeof req.emit;
  } catch {  }
}

// https.Server is a TLS server, not an http.Server, so each prototype is patched for itself.
export function patchIncomingHttp(client: EvalKitClient): void {
  for (const name of ['http', 'https'] as const) {
    try {
      const mod = requireBuiltin<typeof http>(name);
      patchServerPrototype(client, mod.Server.prototype);
    } catch {

    }
  }
}

function patchServerPrototype(client: EvalKitClient, proto: http.Server): void {
  if ((proto.emit as any).__evalkit_server) return;
  if (!claimPatch(proto, 'emit')) return;

  const origEmit = proto.emit as Function;

  function evalkitEmit(this: http.Server, event: string, ...args: any[]): boolean {
    if (event !== 'request') return origEmit.call(this, event, ...args);

    const req = args[0] as http.IncomingMessage;
    const res = args[1] as http.ServerResponse;
    const url = req.url ?? '/';

    if (isPlumbing(url) || tracingSuppressed()) return origEmit.call(this, event, ...args);

    // A health probe or an ignored route is answered untraced, and so is everything its handlers do: in a
    // context with tracing suppressed, which the framework's handlers and their awaits inherit.
    let ignored = false;
    try {
      ignored = isIgnoredRequest(req.method, url);
    } catch {
      ignored = false;
    }
    if (ignored) {
      let quiet: ReturnType<typeof otelContext.active> | undefined;
      try { quiet = suppressedContext(); } catch {  }
      if (quiet) return otelContext.with(quiet, () => origEmit.call(this, event, ...args));
      return origEmit.call(this, event, ...args);
    }

    if (trace.getActiveSpan()?.isRecording()) return origEmit.call(this, event, ...args);

    let ctx: ReturnType<typeof otelContext.active>;
    try {
      const method = (req.method ?? 'GET').toUpperCase();
      let pathname = url;
      try { pathname = new URL(url, 'http://localhost').pathname; } catch { }

      const traceparentHeader = (req.headers as Record<string, string | string[] | undefined>)['traceparent'];
      const parentCtx = traceparentHeader
        ? buildParentCtx(Array.isArray(traceparentHeader) ? traceparentHeader[0] : traceparentHeader)
        : otelContext.active();

      const span = client.tracer.startSpan(
        `${method} ${pathname}`,
        {
          kind: SpanKind.SERVER,
          attributes: {
            'evalkit.span_type': 'http_call',
            'http.method': method,
            'http.url': url,
            'http.request.headers': JSON.stringify(sanitizeHeaders(req.headers as any)),
          },
        },
        parentCtx,
      );

      ctx = trace.setSpan(parentCtx, span);
      markServerSpan(req, { span, ctx });

      const spanCtx = span.spanContext();
      res.setHeader('x-trace-id', spanCtx.traceId);
      res.setHeader('traceparent', `00-${spanCtx.traceId}-${spanCtx.spanId}-01`);

      const BODY_MAX = client.options.maxBodyBytes;
      const reqContentType = String(
        (req.headers as Record<string, string | string[] | undefined>)['content-type'] ?? '',
      ).toLowerCase();
      const isMultipart = reqContentType.includes('multipart/form-data');
      const requestBody = isMultipart ? undefined : observeRequestBody(req, BODY_MAX, span);

      const bodyChunks: Buffer[] = [];
      let bodyLen = 0;
      const captureChunk = (chunk: unknown) => {
        try {
          if (chunk && typeof chunk !== 'function' && bodyLen < BODY_MAX) {
            const b = Buffer.isBuffer(chunk)
              ? chunk
              : typeof chunk === 'string'
                ? Buffer.from(chunk)
                : null;
            if (b && b.length) { bodyChunks.push(b); bodyLen += b.length; }
          }
        } catch {  }
      };
      const origWrite = res.write.bind(res);
      const origEnd = res.end.bind(res);
      (res as any).write = function (chunk: any, ...rest: any[]) { captureChunk(chunk); return (origWrite as any)(chunk, ...rest); };
      (res as any).end = function (chunk: any, ...rest: any[]) { captureChunk(chunk); return (origEnd as any)(chunk, ...rest); };

      // The framework matches the route after this span opened, so the name is settled when the
      // response is done: `GET /orders/:id`, or the raw path when no route matched.
      const nameByRoute = () => {
        const route = serverRoute(req);
        if (route) span.setAttribute('http.route', route);
        const named = serverName(req);
        if (named) span.updateName(named);
        else if (route) span.updateName(`${method} ${route}`);
      };

      let ended = false;
      const finish = (err?: Error): void => {
        if (ended) return;
        ended = true;
        try {
          nameByRoute();
          requestBody?.record();
          span.setAttribute('http.status_code', res.statusCode);
          try {
            const respHeaders = res.getHeaders();
            if (respHeaders && Object.keys(respHeaders).length) {
              span.setAttribute('http.response.headers', JSON.stringify(sanitizeHeaders(respHeaders as any)));
            }
          } catch {  }
          if (bodyChunks.length) {
            try {
              const raw = Buffer.concat(bodyChunks).subarray(0, BODY_MAX).toString('utf-8');
              if (raw) span.setAttribute('http.response.body', raw);
            } catch {  }
          }
          if (err) {
            recordError(span, err, { escaped: false });
          } else {
            // A server span fails for an answer in serverErrorStatusCodes only; any other records no exception.
            const failed = isServerErrorStatus(res.statusCode);
            const handlerError = failed ? serverError(req) : undefined;
            if (handlerError !== undefined) recordError(span, handlerError, { escaped: false });
            // An error recorded on the span keeps its description.
            if (!hasRecordedError(span)) span.setStatus({ code: failed ? SpanStatusCode.ERROR : SpanStatusCode.OK });
          }
          span.end();
        } catch {  }
      };
      // Observed through `emit`, not listeners: an 'error' listener would swallow an error the app has no
      // handler for. 'close' without 'finish' is a client that went away before the response was done.
      try {
        const resEmit = res.emit;
        res.emit = function (this: http.ServerResponse, name: string | symbol, ...rest: any[]): boolean {
          if (name === 'finish' || name === 'close') finish();
          else if (name === 'error') finish(rest[0] instanceof Error ? rest[0] : new Error(String(rest[0])));
          return resEmit.call(this, name, ...rest);
        } as typeof res.emit;
      } catch {  }
    } catch (err) {
      swallow('tracing an incoming request', err);
      return origEmit.call(this, event, ...args);
    }

    return otelContext.with(ctx, () => origEmit.call(this, event, ...args));
  }

  (evalkitEmit as any).__evalkit_server = true;
  proto.emit = evalkitEmit as typeof proto.emit;
}

/**
 * Records the request body as the app's own framework reads it. Every chunk a readable stream hands a
 * consumer goes out through its `emit('data')`, whether the consumer listens for 'data', reads on
 * 'readable', pipes or iterates, so wrapping `emit` sees the body without reading it. Listening for 'data'
 * here would switch the request into flowing mode, and every chunk sent before the framework attached its
 * own reader (after an async auth step, say) would be lost to it. A body nothing reads is not recorded.
 */
function observeRequestBody(
  req: http.IncomingMessage,
  max: number,
  span: { setAttribute: (key: string, value: string) => unknown; isRecording?: () => boolean },
): { record: () => void } {
  const chunks: Buffer[] = [];
  let length = 0;
  let recorded = false;
  const record = (): void => {
    if (recorded || !chunks.length) return;
    recorded = true;
    // A body read only after the response was sent comes too late for its span.
    if (span.isRecording?.() === false) return;
    try {
      const raw = Buffer.concat(chunks).subarray(0, max).toString('utf-8');
      if (raw) span.setAttribute('http.request.body', raw);
    } catch {  }
  };
  try {
    const originalEmit = req.emit;
    req.emit = function (this: http.IncomingMessage, event: string | symbol, ...args: any[]): boolean {
      try {
        if (event === 'data' && length < max) {
          const chunk = args[0];
          const b = Buffer.isBuffer(chunk) ? chunk : typeof chunk === 'string' ? Buffer.from(chunk) : null;
          if (b && b.length) { chunks.push(b); length += b.length; }
        } else if (event === 'end') {
          record();
        }
      } catch {  }
      return originalEmit.call(this, event, ...args);
    } as typeof req.emit;
  } catch {  }
  return { record };
}

function buildParentCtx(traceparent: string): ReturnType<typeof otelContext.active> {
  const parts = traceparent.split('-');
  if (parts.length < 4) return otelContext.active();
  const [, traceId, parentSpanId, flagsHex] = parts;
  if (!traceId || !parentSpanId) return otelContext.active();
  try {
    const spanCtx: any = {
      traceId,
      spanId: parentSpanId,
      isRemote: true,
      traceFlags: parseInt(flagsHex ?? '01', 16),
    };
    return trace.setSpanContext(otelContext.active(), spanCtx);
  } catch {
    return otelContext.active();
  }
}

export function patchFetch(): void {
  if (typeof globalThis.fetch !== 'function') return;
  if ((globalThis.fetch as any).__evalkit) return;
  if (!claimPatch(globalThis, 'fetch')) return;

  const origFetch = globalThis.fetch.bind(globalThis);

  // As for http.request: the SDK's work is guarded, and fetch's own outcome reaches the app as it was.
  globalThis.fetch = async function evalkitFetch(
    input: RequestInfo | URL,
    init?: RequestInit,
  ): Promise<Response> {
    let called = false;
    const callOriginal = (sentInit: RequestInit | undefined): Promise<Response> => {
      called = true;
      return origFetch(input, sentInit);
    };
    try {
      return await tracedFetch(input, init, callOriginal);
    } catch (err) {
      if (called) throw err;
      swallow('tracing a fetch', err);
      return origFetch(input, init);
    }
  } as typeof fetch;

  async function tracedFetch(
    input: RequestInfo | URL,
    init: RequestInit | undefined,
    callOriginal: (sentInit: RequestInit | undefined) => Promise<Response>,
  ): Promise<Response> {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    // A Request carries its own method and headers; headers given in `init` replace the Request's whole,
    // so the added traceparent must travel with the Request's headers when `init` has none of its own.
    const request = typeof input === 'object' && !(input instanceof URL) ? (input as Request) : undefined;
    const method = (init?.method ?? request?.method ?? 'GET').toUpperCase();
    if (shouldSkip(url, method)) return callOriginal(init);

    const activeSpan = trace.getActiveSpan();
    if (!activeSpan?.isRecording()) return callOriginal(init);

    let modifiedInit: RequestInit | undefined = init;
    const rawHeaders: Record<string, string> = {};
    try {
      const sent = init?.headers !== undefined ? init.headers : request?.headers;
      if (sent) new Headers(sent).forEach((v, k) => { rawHeaders[k] = v; });
      const activeSpanCtx = activeSpan.spanContext();
      const headers = new Headers(sent);
      headers.set('traceparent', `00-${activeSpanCtx.traceId}-${activeSpanCtx.spanId}-01`);
      modifiedInit = { ...init, headers };
    } catch {
      modifiedInit = init;
    }
    const sanitizedReq = sanitizeHeaders(rawHeaders);

    if (Object.keys(sanitizedReq).length) {
      activeSpan.addEvent('http.fetch.request', {
        'http.method': method,
        'http.url': url,
        'http.request.headers': JSON.stringify(sanitizedReq),
      });
    }

    try {
      const res = await callOriginal(modifiedInit);
      try {
        const respHeaders: Record<string, string> = {};
        res.headers.forEach((v, k) => { respHeaders[k] = v; });
        activeSpan.addEvent('http.fetch.response', {
          'http.url': url,
          'http.status_code': res.status,
          'http.response.headers': JSON.stringify(sanitizeHeaders(respHeaders)),
        });
      } catch (err) {
        swallow('recording a fetch response', err);
      }
      return res;
    } catch (err: any) {
      try {
        activeSpan.addEvent('http.fetch.error', {
          'http.url': url,
          'error.message': String(err?.message ?? err).slice(0, 2048),
          'error.stack': String(err?.stack ?? '').slice(0, 8192),
        });
      } catch {  }
      throw err;
    }
  }

  (globalThis.fetch as any).__evalkit = true;
}
