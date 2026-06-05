import { trace, context as otelContext, SpanKind, SpanStatusCode } from '@opentelemetry/api';
import type { EvalKitClient } from '../../core/client.js';
import { sanitizeHeaders } from '../../utils/headers.js';
import { _evalkitAxiosSpanMap } from '../../utils/axios-span-map.js';

const SKIP_PATTERNS = [/\/v1\/ingest/, /\/health(z)?$/];

export function patchAxios(client: EvalKitClient, axiosInstance: any): void {
  if ((axiosInstance as any).__evalkit_axios) return;
  (axiosInstance as any).__evalkit_axios = true;

  // Wrap axios.create() so derived instances (NestJS HttpService, etc.) are auto-patched
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
    if (SKIP_PATTERNS.some((p) => p.test(url))) return config;

    const activeSpan = trace.getActiveSpan();
    if (!activeSpan?.isRecording()) return config;

    let pathname = config.url ?? '';
    try { pathname = new URL(url, config.baseURL ?? 'http://localhost').pathname; } catch { }

    const method = (config.method ?? 'get').toUpperCase();
    const reqHeaders = sanitizeHeaders(config.headers ?? {});

    const span = client.tracer.startSpan(`${method} ${pathname}`, {
      kind: SpanKind.CLIENT,
      attributes: {
        'evalkit.span_type': 'http_call',
        'http.method': method,
        'http.url': url,
        ...(Object.keys(reqHeaders).length
          ? { 'http.request.headers': JSON.stringify(reqHeaders) }
          : {}),
        ...(config.data !== undefined
          ? { 'http.request.body': typeof config.data === 'string' ? config.data.slice(0, 4096) : JSON.stringify(config.data).slice(0, 4096) }
          : {}),
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
        const respData = response.data;
        let respBody: string | undefined;
        if (respData !== undefined && respData !== null) {
          respBody = (typeof respData === 'string' ? respData : JSON.stringify(respData)).slice(0, 4096);
        }
        span.setAttributes({
          'http.status_code': response.status,
          ...(Object.keys(respHeaders).length ? { 'http.response.headers': JSON.stringify(respHeaders) } : {}),
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
        const errData = err.response?.data;
        let errBody: string | undefined;
        if (errData !== undefined && errData !== null) {
          errBody = (typeof errData === 'string' ? errData : JSON.stringify(errData)).slice(0, 4096);
        }
        span.setAttributes({
          'http.status_code': sc,
          'error.message': err.message,
          ...(Object.keys(respHeaders).length ? { 'http.response.headers': JSON.stringify(respHeaders) } : {}),
          ...(errBody !== undefined ? { 'http.response.body': errBody } : {}),
        });
        span.recordException(err instanceof Error ? err : new Error(String(err)));
        span.setStatus({ code: SpanStatusCode.ERROR, message: err.message });
        span.end();
      }
      throw err;
    },
  );
}
