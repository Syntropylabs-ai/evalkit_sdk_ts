import * as http from 'http';
import * as https from 'https';
import { trace, context as otelContext, SpanKind, SpanStatusCode } from '@opentelemetry/api';
import type { EvalKitClient } from '../../core/client.js';
import { requireBuiltin } from '../../utils/dynimport.js';
import { sanitizeHeaders } from '../../utils/headers.js';
import { _evalkitAxiosSpanMap } from '../../utils/axios-span-map.js';

const SKIP_PATTERNS = [
  /\/v1\/ingest/,
  /\/health(z)?$/,
  /169\.254\./,
  /metadata\.google/,
  /storage\.googleapis/,
];

function shouldSkip(url: string): boolean {
  return SKIP_PATTERNS.some((p) => p.test(url));
}

function extractUrlMethod(
  input: string | URL | http.RequestOptions,
  secondArg: http.RequestOptions | undefined,
  scheme: string,
): { url: string; method: string; pathname: string } {
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

  let pathname = url;
  try {
    pathname = new URL(url.startsWith('http') ? url : `${scheme}://localhost${url}`).pathname;
  } catch { }

  return { url, method, pathname };
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
    if ((orig as any).__evalkit) continue;

    function evalkitTracedRequest(
      input: string | URL | http.RequestOptions,
      optionsOrCallback?: http.RequestOptions | ((res: http.IncomingMessage) => void),
      callback?: (res: http.IncomingMessage) => void,
    ): http.ClientRequest {
      const options = typeof optionsOrCallback === 'function' ? undefined : optionsOrCallback;
      const { url, method, pathname } = extractUrlMethod(input, options, scheme);

      if (shouldSkip(url)) {
        return orig.call(mod, input, optionsOrCallback, callback);
      }

      const activeSpan = trace.getActiveSpan();
      if (!activeSpan?.isRecording()) {
        return orig.call(mod, input, optionsOrCallback, callback);
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
        return orig.call(mod, input, optionsOrCallback, callback);
      }

      const sanitized = sanitizeHeaders(reqHeaders);

      const span = client.tracer.startSpan(`${method} ${pathname}`, {
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

      const req: http.ClientRequest = orig.call(mod, input, optionsOrCallback, callback);

      const spanCtx = span.spanContext();
      req.setHeader('traceparent', `00-${spanCtx.traceId}-${spanCtx.spanId}-01`);

      req.on('response', (res: http.IncomingMessage) => {
        const sc = res.statusCode ?? 0;
        span.setAttributes({
          'http.status_code': sc,
          ...(res.headers ? { 'http.response.headers': JSON.stringify(sanitizeHeaders(res.headers as any)) } : {}),
        });
        span.setStatus({ code: sc >= 400 ? SpanStatusCode.ERROR : SpanStatusCode.OK });
        span.end();
      });

      req.on('error', (err: Error) => {
        span.setAttributes({ 'http.status_code': 0, 'error.message': err.message });
        span.recordException(err instanceof Error ? err : new Error(String(err)));
        span.setStatus({ code: SpanStatusCode.ERROR, message: err.message });
        span.end();
      });

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

export function patchIncomingHttp(client: EvalKitClient): void {
  let httpMod: typeof http;
  try {
    httpMod = requireBuiltin<typeof http>('http');
  } catch {
    return;
  }

  if ((httpMod.Server.prototype.emit as any).__evalkit_server) return;

  const origEmit = httpMod.Server.prototype.emit as Function;

  function evalkitEmit(this: http.Server, event: string, ...args: any[]): boolean {
    if (event !== 'request') return origEmit.call(this, event, ...args);

    const req = args[0] as http.IncomingMessage;
    const res = args[1] as http.ServerResponse;
    const url = req.url ?? '/';

    if (shouldSkip(url)) return origEmit.call(this, event, ...args);

    if (trace.getActiveSpan()?.isRecording()) return origEmit.call(this, event, ...args);

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

    const ctx = trace.setSpan(parentCtx, span);

    const spanCtx = span.spanContext();
    res.setHeader('x-trace-id', spanCtx.traceId);
    res.setHeader('traceparent', `00-${spanCtx.traceId}-${spanCtx.spanId}-01`);

    const BODY_MAX = client.options.maxBodyBytes;
    const reqContentType = String(
      (req.headers as Record<string, string | string[] | undefined>)['content-type'] ?? '',
    ).toLowerCase();
    const isMultipart = reqContentType.includes('multipart/form-data');
    if (!isMultipart) {
      const reqBodyChunks: Buffer[] = [];
      let reqBodyLen = 0;
      req.on('data', (chunk: unknown) => {
        try {
          if (chunk && reqBodyLen < BODY_MAX) {
            const b = Buffer.isBuffer(chunk) ? chunk : typeof chunk === 'string' ? Buffer.from(chunk) : null;
            if (b && b.length) { reqBodyChunks.push(b); reqBodyLen += b.length; }
          }
        } catch {  }
      });
      req.on('end', () => {
        if (!reqBodyChunks.length) return;
        try {
          const raw = Buffer.concat(reqBodyChunks).subarray(0, BODY_MAX).toString('utf-8');
          if (raw) span.setAttribute('http.request.body', raw);
        } catch {  }
      });
    }

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

    res.on('finish', () => {
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
      span.setStatus({ code: res.statusCode >= 400 ? SpanStatusCode.ERROR : SpanStatusCode.OK });
      span.end();
    });
    res.on('error', (err: Error) => {
      span.setAttribute('error.message', err.message);
      span.recordException(err instanceof Error ? err : new Error(String(err)));
      span.setStatus({ code: SpanStatusCode.ERROR, message: err.message });
      span.end();
    });

    return otelContext.with(ctx, () => origEmit.call(this, event, ...args));
  }

  (evalkitEmit as any).__evalkit_server = true;
  httpMod.Server.prototype.emit = evalkitEmit as typeof httpMod.Server.prototype.emit;
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

  const origFetch = globalThis.fetch.bind(globalThis);

  globalThis.fetch = async function evalkitFetch(
    input: RequestInfo | URL,
    init?: RequestInit,
  ): Promise<Response> {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (shouldSkip(url)) return origFetch(input, init);

    const activeSpan = trace.getActiveSpan();
    if (!activeSpan?.isRecording()) return origFetch(input, init);

    const method = (init?.method ?? 'GET').toUpperCase();
    let pathname = url;
    try { pathname = new URL(url).pathname; } catch { }

    const rawHeaders: Record<string, string> = {};
    if (init?.headers) {
      const h = new Headers(init.headers);
      h.forEach((v, k) => { rawHeaders[k] = v; });
    }
    const sanitizedReq = sanitizeHeaders(rawHeaders);

    const activeSpanCtx = activeSpan.spanContext();
    const traceparent = `00-${activeSpanCtx.traceId}-${activeSpanCtx.spanId}-01`;

    const headers = new Headers(init?.headers);
    headers.set('traceparent', traceparent);
    const modifiedInit: RequestInit = { ...init, headers };

    if (Object.keys(sanitizedReq).length) {
      activeSpan.addEvent('http.fetch.request', {
        'http.method': method,
        'http.url': url,
        'http.request.headers': JSON.stringify(sanitizedReq),
      });
    }

    try {
      const res = await origFetch(input, modifiedInit);
      const respHeaders: Record<string, string> = {};
      res.headers.forEach((v, k) => { respHeaders[k] = v; });
      activeSpan.addEvent('http.fetch.response', {
        'http.url': url,
        'http.status_code': res.status,
        'http.response.headers': JSON.stringify(sanitizeHeaders(respHeaders)),
      });
      return res;
    } catch (err: any) {
      activeSpan.addEvent('http.fetch.error', {
        'http.url': url,
        'error.message': err?.message ?? String(err),
        'error.stack': err?.stack ?? '',
      });
      throw err;
    }
  } as typeof fetch;

  (globalThis.fetch as any).__evalkit = true;
}
