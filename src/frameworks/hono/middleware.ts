import { context as otelContext } from '@opentelemetry/api';
import type { EvalKitClient, HttpTraceResponse } from '../../core/client.js';
import { extractTraceparent } from '../../core/context.js';
import { isServerErrorStatus, serverSpanStatus, statusOfError } from '../../core/http-status.js';
import { serverSpanOf, setServerError, setServerName, setServerRoute } from '../../utils/http-route.js';
import { isIgnoredRequest } from '../../core/ignore.js';
import { tracingSuppressed, untracedRequest } from '../../core/suppress.js';

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
    // Already untraced: the http server left out an ignored route or a probe.
    if (tracingSuppressed()) return next();
    // A health probe or an ignored route is answered untraced, with everything the rest of the chain does; on
    // a runtime without Node's http server the middleware is the only place that can tell.
    if (isIgnoredRequest(req.method, url)) return otelContext.with(untracedRequest(c.env?.incoming), next);
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
        // Hono answers what a handler throws through app.onError, inside next(), and keeps it on c.error.
        if (c.error !== undefined) setServerError(incoming, c.error);
      } catch (err) {
        // Answered next, with the status it carries; the server span records it if that is a server error.
        setServerError(incoming, err);
        throw err;
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

    let ended = false;
    const endOnce = (status: 'OK' | 'ERROR', response: HttpTraceResponse): void => {
      if (ended) return;
      ended = true;
      // Hono matches the route after this middleware started, so the span is named by it as it ends.
      const route = options?.name === undefined ? honoRoute(c) : undefined;
      try { end(status, route ? { ...response, route } : response); } catch {  }
    };
    try {
      await otelContext.with(ctx, next);
    } catch (err: any) {
      // An HTTPException is answered with its own status, any other error with a 500; an answer outside
      // serverErrorStatusCodes records no exception.
      try {
        const statusCode = statusOfError(err) ?? 500;
        if (isServerErrorStatus(statusCode)) endOnce('ERROR', { statusCode, error: err, errorEscaped: true });
        else endOnce('OK', { statusCode });
      } catch {  }
      throw err;
    }
    let sc = 200;
    try {
      const res: Response | undefined = c.res;
      sc = res?.status ?? 200;
      // Hono answers what a handler throws through app.onError, inside next(), and keeps it on c.error; it is
      // recorded when that answer is a server error.
      const error = isServerErrorStatus(sc) ? c.error : undefined;
      const answered = (body?: string): void => endOnce(serverSpanStatus(sc), {
        statusCode: sc,
        body,
        ...(error !== undefined ? { error, errorEscaped: false } : {}),
      });
      const failedMidway = (streamError: unknown): void => endOnce('ERROR', { statusCode: sc, error: streamError, errorEscaped: true });
      const watched = res ? watchBody(res, client.options.maxBodyBytes, answered, failedMidway) : undefined;
      if (watched) c.res = watched;
      else answered();
    } catch {
      endOnce(serverSpanStatus(sc), { statusCode: sc });
    }
  };
}

/**
 * The response with its body passed through as the runtime sends it, so the span ends when the last byte has
 * gone, or when the client went away, and keeps the body's first `max` bytes. Reading the body ahead would
 * hold a streamed response (server-sent events, a model's tokens) back from the client until it was complete.
 * Undefined when there is no body to watch.
 */
function watchBody(
  res: Response,
  max: number,
  done: (body?: string) => void,
  failed: (err: unknown) => void,
): Response | undefined {
  const body = res.body;
  if (!body || res.bodyUsed || res.status === 101 || typeof body.getReader !== 'function') return undefined;
  if (typeof ReadableStream !== 'function' || typeof Response !== 'function') return undefined;
  const reader = body.getReader();
  const kept: Uint8Array[] = [];
  let keptBytes = 0;
  const text = (): string | undefined => {
    if (!keptBytes) return undefined;
    try {
      const all = new Uint8Array(keptBytes);
      let at = 0;
      for (const part of kept) { all.set(part, at); at += part.length; }
      return new TextDecoder().decode(all) || undefined;
    } catch {
      return undefined;
    }
  };
  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      let step: ReadableStreamReadResult<Uint8Array>;
      try {
        step = await reader.read();
      } catch (err) {
        failed(err);
        controller.error(err);
        return;
      }
      if (step.done) {
        done(text());
        controller.close();
        return;
      }
      const chunk = step.value;
      try {
        if (max > 0 && keptBytes < max && chunk instanceof Uint8Array) {
          const part = chunk.slice(0, max - keptBytes);
          kept.push(part);
          keptBytes += part.length;
        }
      } catch {  }
      controller.enqueue(chunk);
    },
    cancel(reason) {
      // The client went away mid-answer; the span ends as the request was answered.
      done(text());
      return reader.cancel(reason);
    },
  });
  return new Response(stream, { status: res.status, statusText: res.statusText, headers: res.headers });
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
