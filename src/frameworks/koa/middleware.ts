import { context as otelContext } from '@opentelemetry/api';
import type { EvalKitClient } from '../../core/client.js';
import { extractTraceparent } from '../../core/context.js';
import { serverSpanOf, setServerName, setServerRoute } from '../../utils/http-route.js';
import { isHealthCheck } from '../../utils/health-check.js';

export interface KoaMiddlewareOptions {
  name?: string | ((ctx: any) => string);
}

export function createKoaMiddleware(
  client: EvalKitClient,
  options?: KoaMiddlewareOptions,
): (ctx: any, next: () => Promise<void>) => Promise<void> {
  return async (ctx: any, next: () => Promise<void>) => {
    // A health probe is not recorded, as the http server's own instrumentation does not record it.
    if (isHealthCheck(ctx.path ?? ctx.url)) return next();

    const traceName = typeof options?.name === 'function'
      ? options.name(ctx)
      : (options?.name ?? `${String(ctx.method ?? 'GET')} ${String(ctx.path ?? '/')}`);

    // On Node's http server the request already has its server span; the middleware names that one, by the
    // route a router matched, rather than recording the request a second time.
    const core = serverSpanOf(ctx.req);
    if (core) {
      if (options?.name !== undefined) setServerName(ctx.req, traceName);
      try {
        await next();
      } finally {
        setServerRoute(ctx.req, ctx._matchedRoute ?? ctx.routerPath);
      }
      return;
    }

    const parentCtx = extractTraceparent(ctx.request?.headers?.['traceparent']);

    const { end, ctx: otelCtx } = otelContext.with(parentCtx, () =>
      client.startHttpTrace(traceName, {
        method: String(ctx.method ?? 'GET'),
        url: String(ctx.href ?? ctx.url ?? '/'),
        headers: ctx.request?.headers as Record<string, string>,
        requestBody: ctx.request?.body,
      })
    );

    ctx._evalkitCtx = otelCtx;

    try {
      await otelContext.with(otelCtx, next);
      const sc = ctx.status ?? 200;
      let responseBody: string | undefined;
      try {
        const b = ctx.body;
        if (b !== undefined && b !== null) {
          responseBody = (typeof b === 'string' ? b : JSON.stringify(b)).slice(0, client.options.maxBodyBytes);
        }
      } catch {  }
      end(sc >= 400 ? 'ERROR' : 'OK', { statusCode: sc, body: responseBody });
    } catch (err: any) {
      end('ERROR', { statusCode: ctx.status ?? 500 });
      throw err;
    }
  };
}
