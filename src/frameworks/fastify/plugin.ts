import { context as otelContext, trace } from '@opentelemetry/api';
import type { Context as OtelContext } from '@opentelemetry/api';
import type { EvalKitClient } from '../../core/client.js';
import { boundedText } from '../../core/serialize.js';
import { swallow } from '../../core/guard.js';
import { isServerErrorStatus, serverSpanStatus } from '../../core/http-status.js';
import { serverError, serverSpanOf, setServerError, setServerName, setServerRoute } from '../../utils/http-route.js';
import { isIgnoredRequest } from '../../core/ignore.js';
import { tracingSuppressed, untracedRequest } from '../../core/suppress.js';

export interface FastifyPluginOptions {
  name?: string | ((request: any) => string);
}

type TraceparentExtractor = (header: string | undefined) => OtelContext;

export function createFastifyPlugin(
  client: EvalKitClient,
  pluginOpts: FastifyPluginOptions = {},
  extractTraceparent?: TraceparentExtractor,
) {
  function evalkitFastifyPlugin(
    fastify: any,
    opts: FastifyPluginOptions,
    pluginDone: () => void,
  ): void {
    const resolvedOpts: FastifyPluginOptions = { ...pluginOpts, ...opts };

    fastify.addHook(
      'onRequest',
      (request: any, _reply: any, hookDone: () => void) => {
        // Already untraced: the http server left out an ignored route or a probe.
        if (tracingSuppressed()) {
          hookDone();
          return;
        }
        // A health probe or an ignored route is answered untraced, with everything its handler does. Fastify has
        // matched the route by now, so a pattern written as the route's template matches too.
        if (isIgnoredRequest(request.method, request.url, request.routeOptions?.url ?? request.routerPath)) {
          const quiet = untracedRequest(request.raw);
          request._evalkitIgnored = quiet;
          otelContext.with(quiet, hookDone);
          return;
        }
        const routePath =
          request.routerPath ??
          request.routeOptions?.url ??
          request.url ??
          '/';
        setServerRoute(request.raw, request.routeOptions?.url ?? request.routerPath);
        const traceName =
          typeof resolvedOpts.name === 'function'
            ? resolvedOpts.name(request)
            : (resolvedOpts.name ??
              `${String(request.method ?? 'GET')} ${String(routePath)}`);

        // On Node's http server the request already has its server span; the plugin names that one rather
        // than recording the request a second time.
        const core = serverSpanOf(request.raw);
        if (core) {
          if (resolvedOpts.name !== undefined) setServerName(request.raw, traceName);
          request._evalkitCtx = core.ctx;
          otelContext.with(core.ctx as OtelContext, hookDone);
          return;
        }

        const traceparentHeader = request.headers?.['traceparent'] as string | undefined;
        const parentCtx = extractTraceparent
          ? extractTraceparent(traceparentHeader)
          : otelContext.active();

        const { traceId, end, ctx } = otelContext.with(parentCtx, () =>
          client.startHttpTrace(traceName, {
            method: String(request.method ?? 'GET'),
            url: String(request.url ?? '/'),
            headers: request.headers as Record<string, string>,
            requestBody: undefined,
          })
        );

        request._evalkitCtx = ctx;
        request._evalkitTraceId = traceId;
        request._evalkitEnd = end;
        request._evalkitEnded = false;

        otelContext.with(ctx, hookDone);
      },
    );

    fastify.addHook(
      'preHandler',
      (request: any, _reply: any, hookDone: () => void) => {
        if (request._evalkitIgnored) {
          otelContext.with(request._evalkitIgnored as OtelContext, hookDone);
          return;
        }
        if (request._evalkitCtx && request.body !== undefined) {
          const activeSpan = trace.getActiveSpan();
          if (activeSpan?.isRecording()) {
            try {
              const max = client.options.maxBodyBytes;
              const body = typeof request.body === 'string' ? request.body.slice(0, max) : boundedText(request.body, max);
              if (max > 0 && body !== undefined) activeSpan.setAttribute('http.request.body', body);
            } catch { }
          }
        }
        otelContext.with(request._evalkitCtx ?? otelContext.active(), hookDone);
      },
    );

    fastify.addHook(
      'onSend',
      (request: any, reply: any, payload: any, hookDone: (err: null, payload: any) => void) => {
        try {
          const max = client.options.maxBodyBytes;
          if (payload !== undefined && payload !== null && max > 0 && typeof request._evalkitEnd === 'function') {
            request._evalkitRespBody = typeof payload === 'string'
              ? payload.slice(0, max)
              : Buffer.isBuffer(payload)
                ? payload.subarray(0, max).toString('utf8')
                // A stream is sent as it is read; there is nothing to record of it here.
                : typeof payload.pipe === 'function' ? undefined : boundedText(payload, max);
          }
        } catch {  }
        hookDone(null, payload);
      },
    );

    fastify.addHook(
      'onResponse',
      (request: any, reply: any, hookDone: () => void) => {
        if (typeof request._evalkitEnd === 'function' && !request._evalkitEnded) {
          request._evalkitEnded = true;
          const sc: number = reply.statusCode ?? 200;
          // The error onError saw is recorded only when the error handler answered it with a server error.
          const error = isServerErrorStatus(sc) ? serverError(request) : undefined;
          request._evalkitEnd(serverSpanStatus(sc), {
            statusCode: sc,
            body: request._evalkitRespBody,
            ...(error !== undefined ? { error, errorEscaped: false } : {}),
          });
        }
        hookDone();
      },
    );

    fastify.addHook(
      'onError',
      (request: any, _reply: any, error: unknown, hookDone: () => void) => {
        // Fastify runs onError before its error handler chooses the status, so the error waits for the
        // response: the request's span records it then, if the answer is a server error. On Node's http server
        // that span is the server span, which reads it from the raw request.
        try {
          if (request._evalkitCtx) setServerError(serverSpanOf(request.raw) ? request.raw : request, error);
        } catch (err) {
          swallow('recording a Fastify error', err);
        }
        hookDone();
      },
    );

    // A request the client gave up on gets no onResponse (Fastify 4.17 and later have this hook).
    try {
      fastify.addHook('onRequestAbort', (request: any, hookDone: () => void) => {
        try {
          if (typeof request._evalkitEnd === 'function' && !request._evalkitEnded) {
            request._evalkitEnded = true;
            request._evalkitEnd(serverSpanStatus(499), { statusCode: 499 });
          }
        } catch {  }
        hookDone();
      });
    } catch {
      // An older Fastify ends such a request in onResponse.
    }

    pluginDone();
  }

  (evalkitFastifyPlugin as any)[Symbol.for('skip-override')] = true;

  return evalkitFastifyPlugin;
}
