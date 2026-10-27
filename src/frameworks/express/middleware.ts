import { context as otelContext, trace as otelTrace } from '@opentelemetry/api';
import type { Context as OtelContext } from '@opentelemetry/api';
import type { EvalKitClient } from '../../core/client.js';
import { extractTraceparent } from '../../core/context.js';
import { recordError } from '../../core/exceptions.js';
import { swallow } from '../../core/guard.js';
import { isServerErrorStatus, serverSpanStatus, statusOfError } from '../../core/http-status.js';
import { serverError, serverRoute, serverSpanOf, setServerError, setServerName } from '../../utils/http-route.js';
import { isIgnoredRequest } from '../../core/ignore.js';
import { untracedRequest, tracingSuppressed } from '../../core/suppress.js';

export interface ExpressMiddlewareOptions {
  name?: string | ((req: any) => string);
}

/**
 * Starts tracing one request; the context to run the rest of the chain in, or undefined to run it as without
 * the SDK. Everything the SDK does for the request happens here, so nothing of it can throw into the chain.
 */
function traceRequest(client: EvalKitClient, options: ExpressMiddlewareOptions | undefined, req: any, res: any): OtelContext | undefined {
  // Already untraced (the http server left out an ignored route or a probe, or the app's own untraced scope).
  if (tracingSuppressed()) return undefined;
  // A health probe or an ignored route is answered untraced, with everything the chain does for it.
  if (isIgnoredRequest(req.method, req.originalUrl ?? req.url, serverRoute(req))) return untracedRequest(req);
  if (req._evalkitCtx || otelTrace.getActiveSpan()?.isRecording()) {
    if (typeof options?.name === 'string' && serverSpanOf(req)) setServerName(req, options.name);
    else if (typeof options?.name === 'function' && serverSpanOf(req)) {
      try { setServerName(req, options.name(req)); } catch {  }
    }
    return undefined;
  }
  const traceName = typeof options?.name === 'function'
    ? options.name(req)
    : (options?.name ?? `${String(req.method)} ${String(req.route?.path ?? req.path ?? req.url)}`);

  const parentCtx = extractTraceparent(req.headers?.['traceparent'] as string | undefined);

  const { end, ctx, traceId } = otelContext.with(parentCtx, () =>
    client.startHttpTrace(traceName, {
      method: String(req.method ?? 'GET'),
      url: String(req.originalUrl ?? req.url ?? '/'),
      headers: req.headers as Record<string, string>,
      requestBody: req.body,
    })
  );

  (req as any)._evalkitCtx = ctx;
  (req as any)._evalkitTraceId = traceId;

  try {
    const spanId = otelTrace.getSpan(ctx)?.spanContext().spanId ?? '0000000000000000';
    res.setHeader?.('x-trace-id', traceId);
    res.setHeader?.('traceparent', `00-${traceId}-${spanId}-01`);
  } catch {
    // Headers already sent: the trace still records the request.
  }

  const BODY_MAX = client.options.maxBodyBytes;
  const bodyChunks: Buffer[] = [];
  let bodyLen = 0;
  const captureChunk = (chunk: unknown): void => {
    if (!chunk || bodyLen >= BODY_MAX) return;
    try {
      const b = Buffer.isBuffer(chunk)
        ? chunk
        : typeof chunk === 'string'
          ? Buffer.from(chunk)
          : null;
      if (b?.length) { bodyChunks.push(b); bodyLen += b.length; }
    } catch {  }
  };

  const origWrite = (res.write as (...args: any[]) => any).bind(res);
  const origEnd = res.end as (...args: any[]) => any;
  let ended = false;

  (res as any).write = function (chunk: any, ...rest: any[]) {
    captureChunk(chunk);
    return origWrite(chunk, ...rest);
  };

  res.end = function (...args: any[]) {
    if (!ended) {
      ended = true;
      try {
        captureChunk(args[0]);
        const sc = (res.statusCode as number) ?? 200;
        let responseBody: string | undefined;
        if (bodyChunks.length) {
          try {
            responseBody = Buffer.concat(bodyChunks).subarray(0, BODY_MAX).toString('utf-8');
          } catch {  }
        }
        // The error expressErrorHandler() saw is recorded only when it was answered with a server error.
        const handlerError = isServerErrorStatus(sc) ? serverError(req) : undefined;
        end(serverSpanStatus(sc), {
          statusCode: sc,
          headers: res.getHeaders ? res.getHeaders() as Record<string, string> : undefined,
          body: responseBody,
          // Express matches the route after this middleware ran, so it is read when the response ends.
          route: options?.name === undefined ? serverRoute(req) : undefined,
          ...(handlerError !== undefined ? { error: handlerError, errorEscaped: false } : {}),
        });
      } catch (err) {
        swallow('ending an Express request span', err);
      }
    }
    return origEnd.apply(res, args);
  };

  return ctx;
}

export function createExpressMiddleware(
  client: EvalKitClient,
  options?: ExpressMiddlewareOptions,
): (req: any, res: any, next: any) => void {
  return (req: any, res: any, next: any) => {
    let ctx: OtelContext | undefined;
    try {
      ctx = traceRequest(client, options, req, res);
    } catch (err) {
      swallow('tracing an Express request', err);
      ctx = undefined;
    }
    if (ctx) otelContext.with(ctx, () => next());
    else next();
  };
}

/**
 * Hands the error a route passed to `next(err)` (or threw) to the request's span by the exception contract,
 * then passes it on unchanged. Express tells error handlers by their four parameters. The status the error is
 * answered with is chosen after this handler, by the app's own error handlers or Express's (the error's
 * `status`, else 500), so the span records it when the response ends, and only for a server error: a 404 or a
 * 401 an error becomes is the caller's.
 */
export function createExpressErrorHandler(): (err: any, req: any, res: any, next: any) => void {
  return function evalkitErrorHandler(err: any, req: any, _res: any, next: any): void {
    try {
      if (req && typeof req === 'object' && (req._evalkitCtx || serverSpanOf(req))) {
        setServerError(req, err);
      } else if (isServerErrorStatus(statusOfError(err) ?? 500)) {
        // A request the SDK does not record: the error goes on the active span, as the status it carries says.
        // It became a response here, so it did not escape that span.
        recordError(otelTrace.getActiveSpan(), err, { escaped: false });
      }
    } catch (hookErr) {
      swallow('recording an Express error', hookErr);
    }
    next(err);
  };
}
