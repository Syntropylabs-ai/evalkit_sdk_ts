import { context as otelContext } from '@opentelemetry/api';
import type { EvalKitClient } from '../../core/client.js';
import { extractTraceparent } from '../../core/context.js';

export interface KoaMiddlewareOptions {
  name?: string | ((ctx: any) => string);
}

/**
 * Koa middleware that auto-traces every incoming request.
 *
 * @example
 * import Koa from 'koa';
 * import evalkit from 'syntropylabs-evalkit';
 *
 * evalkit.init({ subscriptionKey: '...', serviceName: 'my-api' });
 * const app = new Koa();
 * app.use(evalkit.koaMiddleware());
 */
export function createKoaMiddleware(
  client: EvalKitClient,
  options?: KoaMiddlewareOptions,
): (ctx: any, next: () => Promise<void>) => Promise<void> {
  return async (ctx: any, next: () => Promise<void>) => {
    const traceName = typeof options?.name === 'function'
      ? options.name(ctx)
      : (options?.name ?? `${String(ctx.method ?? 'GET')} ${String(ctx.path ?? '/')}`);

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
      end(sc >= 400 ? 'ERROR' : 'OK', { statusCode: sc });
    } catch (err: any) {
      end('ERROR', { statusCode: ctx.status ?? 500 });
      throw err;
    }
  };
}
