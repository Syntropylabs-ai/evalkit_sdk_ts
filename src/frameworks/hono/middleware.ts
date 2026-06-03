import { context as otelContext } from '@opentelemetry/api';
import type { EvalKitClient } from '../../core/client.js';
import { extractTraceparent } from '../../core/context.js';

export interface HonoMiddlewareOptions {
  name?: string | ((c: any) => string);
}

/**
 * Hono middleware that auto-traces every incoming request.
 * Edge-compatible (Cloudflare Workers, Vercel Edge, Deno Deploy).
 *
 * @example
 * import { Hono } from 'hono';
 * import evalkit from '@evalkit/sdk';
 *
 * evalkit.init({ subscriptionKey: '...', serviceName: 'my-api' });
 * const app = new Hono();
 * app.use('*', evalkit.honoMiddleware());
 */
export function createHonoMiddleware(
  client: EvalKitClient,
  options?: HonoMiddlewareOptions,
): (c: any, next: () => Promise<void>) => Promise<void> {
  return async (c: any, next: () => Promise<void>) => {
    const req = c.req;
    const url = req.url ?? '/';
    let pathname = url;
    try { pathname = new URL(url).pathname; } catch { }

    const traceName = typeof options?.name === 'function'
      ? options.name(c)
      : (options?.name ?? `${String(req.method ?? 'GET')} ${pathname}`);

    const parentCtx = extractTraceparent(req.header('traceparent'));

    const { end, ctx } = otelContext.with(parentCtx, () =>
      client.startHttpTrace(traceName, {
        method: String(req.method ?? 'GET'),
        url,
        headers: Object.fromEntries(req.raw?.headers ?? []),
      })
    );

    try {
      await otelContext.with(ctx, next);
      const sc = c.res?.status ?? 200;
      end(sc >= 400 ? 'ERROR' : 'OK', { statusCode: sc });
    } catch (err: any) {
      end('ERROR', { statusCode: 500 });
      throw err;
    }
  };
}
