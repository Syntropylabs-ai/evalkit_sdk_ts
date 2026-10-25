import { trace, context as otelContext, SpanKind, SpanStatusCode } from '@opentelemetry/api';
import { recordError } from '../../core/exceptions.js';
import type { EvalKitClient } from '../../core/client.js';
import { sanitizeHeaders } from '../../utils/headers.js';
import { _evalkitAxiosSpanMap } from '../../utils/axios-span-map.js';
import { clientSpanName } from '../../utils/http-route.js';
import { isIgnoredUrl } from '../../core/ignore.js';
import { tracingSuppressed } from '../../core/suppress.js';

const INGEST_RE = /\/v1\/ingest/;

function safeStringify(v: any): string | undefined {
  try { return JSON.stringify(v); } catch { return undefined; }
}

function captureBody(data: any, max: number): string | undefined {
  if (data === undefined || data === null) return undefined;
  if (typeof data === 'string') return data.slice(0, max);
  if (typeof data.pipe === 'function' || typeof data.read === 'function') return undefined;
  if (typeof Buffer !== 'undefined' && Buffer.isBuffer(data)) return undefined;
  if (data instanceof ArrayBuffer) return undefined;
  const s = safeStringify(data);
  return s === undefined ? undefined : s.slice(0, max);
}

export function patchAxios(client: EvalKitClient, axiosInstance: any): void {
  if ((axiosInstance as any).__evalkit_axios) return;
  (axiosInstance as any).__evalkit_axios = true;

  if (typeof axiosInstance.create === 'function') {
    const origCreate = axiosInstance.create.bind(axiosInstance);
    axiosInstance.create = function (...args: any[]) {
      const newInstance = origCreate(...args);
      patchAxios(client, newInstance);
      return newInstance;
    };
  }

  axiosInstance.interceptors.request.use((config: any) => {
    const url = (config.baseURL ? config.baseURL.replace(/\/$/, '') : '') + (config.url ?? '');
    const method = (config.method ?? 'get').toUpperCase();
    // An ignored URL, a health probe or a call made inside an untraced scope goes out as without the SDK.
    if (INGEST_RE.test(url) || isIgnoredUrl(url, method) || tracingSuppressed()) return config;

    const activeSpan = trace.getActiveSpan();
    if (!activeSpan?.isRecording()) return config;

    const reqHeaders = sanitizeHeaders(config.headers ?? {});
    const reqHeadersStr = Object.keys(reqHeaders).length ? safeStringify(reqHeaders) : undefined;
    const reqBody = captureBody(config.data, client.options.maxBodyBytes);

    const span = client.tracer.startSpan(clientSpanName(method), {
      kind: SpanKind.CLIENT,
      attributes: {
        'evalkit.span_type': 'http_call',
        'http.method': method,
        'http.url': url,
        ...(reqHeadersStr ? { 'http.request.headers': reqHeadersStr } : {}),
        ...(reqBody !== undefined ? { 'http.request.body': reqBody } : {}),
      },
    }, otelContext.active());

    const spanCtx = span.spanContext();
    config.headers = config.headers ?? {};
    config.headers['traceparent'] = `00-${spanCtx.traceId}-${spanCtx.spanId}-01`;
    config.headers['x-evalkit-span-id'] = spanCtx.spanId;
    _evalkitAxiosSpanMap.set(spanCtx.spanId, span);

    config.__evalkitSpan = span;
    config.__evalkitSpanId = spanCtx.spanId;
    return config;
  });

  axiosInstance.interceptors.response.use(
    (response: any) => {
      const span = response.config?.__evalkitSpan;
      if (response.config?.__evalkitSpanId) _evalkitAxiosSpanMap.delete(response.config.__evalkitSpanId);
      if (span) {
        const respHeaders = sanitizeHeaders(response.headers ?? {});
        const respHeadersStr = Object.keys(respHeaders).length ? safeStringify(respHeaders) : undefined;
        const respBody = captureBody(response.data, client.options.maxBodyBytes);
        span.setAttributes({
          'http.status_code': response.status,
          ...(respHeadersStr ? { 'http.response.headers': respHeadersStr } : {}),
          ...(respBody !== undefined ? { 'http.response.body': respBody } : {}),
        });
        span.setStatus({ code: SpanStatusCode.OK });
        span.end();
      }
      return response;
    },
    (err: any) => {
      const span = err.config?.__evalkitSpan;
      if (err.config?.__evalkitSpanId) _evalkitAxiosSpanMap.delete(err.config.__evalkitSpanId);
      if (span) {
        const sc = err.response?.status ?? 0;
        const respHeaders = sanitizeHeaders(err.response?.headers ?? {});
        const respHeadersStr = Object.keys(respHeaders).length ? safeStringify(respHeaders) : undefined;
        const errBody = captureBody(err.response?.data, client.options.maxBodyBytes);
        span.setAttributes({
          'http.status_code': sc,
          'error.message': err.message,
          ...(respHeadersStr ? { 'http.response.headers': respHeadersStr } : {}),
          ...(errBody !== undefined ? { 'http.response.body': errBody } : {}),
        });
        recordError(span, err instanceof Error ? err : new Error(String(err)), { escaped: true });
        span.end();
      }
      throw err;
    },
  );
}
