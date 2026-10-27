import { context as otelContext } from '@opentelemetry/api';
import type { EvalKitClient } from '../../core/client.js';
import { boundedText } from '../../core/serialize.js';
import { extractTraceparent } from '../../core/context.js';
import { isServerErrorStatus, serverSpanStatus, statusOfError } from '../../core/http-status.js';
import { serverSpanOf, setServerError, setServerName, setServerRoute } from '../../utils/http-route.js';
import { isIgnoredRequest } from '../../core/ignore.js';
import { tracingSuppressed, untracedRequest } from '../../core/suppress.js';

export interface KoaMiddlewareOptions {
  name?: string | ((ctx: any) => string);
}

export function createKoaMiddleware(
  client: EvalKitClient,
  options?: KoaMiddlewareOptions,
): (ctx: any, next: () => Promise<void>) => Promise<void> {
  return async (ctx: any, next: () => Promise<void>) => {
    // Already untraced: the http server left out an ignored route or a probe.
    if (tracingSuppressed()) return next();
    // A health probe or an ignored route is answered untraced, with everything the rest of the chain does.
    if (isIgnoredRequest(ctx.method, ctx.path ?? ctx.url, ctx._matchedRoute)) {
      return otelContext.with(untracedRequest(ctx.req), next);
    }

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
      } catch (err) {
        // Koa answers it next, with the status it carries; the server span records it if that is a server error.
        setServerError(ctx.req, err);
        throw err;
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
    // A router matches the route inside next(), so the span is named by it as it ends.
    const routed = (): { route?: string } => {
      const route = options?.name === undefined ? ctx._matchedRoute ?? ctx.routerPath : undefined;
      return typeof route === 'string' && route.startsWith('/') ? { route } : {};
    };

    try {
      await otelContext.with(otelCtx, next);
      const sc = ctx.status ?? 200;
      let responseBody: string | undefined;
      try {
        const b = ctx.body;
        if (b !== undefined && b !== null) {
          responseBody = typeof b === 'string' ? b.slice(0, client.options.maxBodyBytes) : boundedText(b, client.options.maxBodyBytes);
        }
      } catch {  }
      end(serverSpanStatus(sc), { statusCode: sc, body: responseBody, ...routed() });
    } catch (err: any) {
      // The error propagates to Koa's own handling, out of this middleware's span. Koa answers it with the
      // status it carries (`ctx.throw(404)`, an http-errors error), else 500; an answer outside
      // serverErrorStatusCodes records no exception.
      try {
        const statusCode = statusOfError(err) ?? 500;
        if (isServerErrorStatus(statusCode)) end('ERROR', { statusCode, error: err, errorEscaped: true, ...routed() });
        else end('OK', { statusCode, ...routed() });
      } catch {  }
      throw err;
    }
  };
}
