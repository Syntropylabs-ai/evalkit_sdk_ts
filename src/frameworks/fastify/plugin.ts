import { context as otelContext, trace } from '@opentelemetry/api';
import type { Context as OtelContext } from '@opentelemetry/api';
import type { EvalKitClient } from '../../core/client.js';
import { setServerRoute } from '../../utils/http-route.js';

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
        if (request._evalkitCtx && request.body !== undefined) {
          const activeSpan = trace.getActiveSpan();
          if (activeSpan?.isRecording()) {
            try {
              activeSpan.setAttribute(
                'http.request.body',
                typeof request.body === 'string'
                  ? request.body.slice(0, client.options.maxBodyBytes)
                  : JSON.stringify(request.body).slice(0, client.options.maxBodyBytes),
              );
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
          if (payload !== undefined && payload !== null) {
            const s = (typeof payload === 'string' ? payload : JSON.stringify(payload)).slice(0, client.options.maxBodyBytes);
            request._evalkitRespBody = s;
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
          request._evalkitEnd(sc >= 400 ? 'ERROR' : 'OK', {
            statusCode: sc,
            body: request._evalkitRespBody,
          });
        }
        hookDone();
      },
    );

    fastify.addHook(
      'onError',
      (request: any, reply: any, _error: Error, hookDone: () => void) => {
        if (typeof request._evalkitEnd === 'function' && !request._evalkitEnded) {
          request._evalkitEnded = true;
          request._evalkitEnd('ERROR', { statusCode: reply.statusCode ?? 500 });
        }
        hookDone();
      },
    );

    pluginDone();
  }

  (evalkitFastifyPlugin as any)[Symbol.for('skip-override')] = true;

  return evalkitFastifyPlugin;
}
