import { context as otelContext } from '@opentelemetry/api';
import type { EvalKitClient } from '../../core/client.js';
import { extractTraceparent } from '../../core/context.js';
import { serverSpanOf, setServerName, setServerRoute } from '../../utils/http-route.js';
import { isHealthCheck } from '../../utils/health-check.js';

export interface HonoMiddlewareOptions {
  name?: string | ((c: any) => string);
}

export function createHonoMiddleware(
  client: EvalKitClient,
  options?: HonoMiddlewareOptions,
): (c: any, next: () => Promise<void>) => Promise<void> {
  return async (c: any, next: () => Promise<void>) => {
    const req = c.req;
    const url = req.url ?? '/';
    // A health probe is not recorded, as the http server's own instrumentation does not record it; on a
    // runtime without Node's http server the middleware is the only place that can tell.
    if (isHealthCheck(url)) return next();
    let pathname = url;
    try { pathname = new URL(url).pathname; } catch { }

    const traceName = typeof options?.name === 'function'
      ? options.name(c)
      : (options?.name ?? `${String(req.method ?? 'GET')} ${pathname}`);

    // On Node's http server (the Node adapter hands the request over as `env.incoming`) the request already
    // has its server span; the middleware names that one rather than recording the request a second time.
    const incoming = c.env?.incoming;
    const core = serverSpanOf(incoming);
    if (core) {
      if (options?.name !== undefined) setServerName(incoming, traceName);
      try {
        await next();
      } finally {
        setServerRoute(incoming, honoRoute(c));
      }
      return;
    }

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
      let responseBody: string | undefined;
      try {

        if (c.res && typeof c.res.clone === 'function') {
          const text = await c.res.clone().text();
          if (text) responseBody = text.slice(0, client.options.maxBodyBytes);
        }
      } catch {  }
      end(sc >= 400 ? 'ERROR' : 'OK', { statusCode: sc, body: responseBody });
    } catch (err: any) {
      end('ERROR', { statusCode: 500 });
      throw err;
    }
  };
}

/** The path of the route that handled the request: the last match that is not middleware. */
function honoRoute(c: any): string | undefined {
  try {
    const matched: Array<{ path?: string; method?: string }> = c.req?.matchedRoutes ?? [];
    for (let i = matched.length - 1; i >= 0; i--) {
      if (matched[i]?.method !== 'ALL' && typeof matched[i]?.path === 'string') return matched[i].path;
    }
    const routePath = c.req?.routePath;
    return typeof routePath === 'string' && routePath !== '*' && routePath !== '/*' ? routePath : undefined;
  } catch {
    return undefined;
  }
}
