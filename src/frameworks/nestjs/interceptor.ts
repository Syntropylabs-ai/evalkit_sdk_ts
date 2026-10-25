import { context as otelContext } from '@opentelemetry/api';
import type { Span } from '@opentelemetry/api';
import type { EvalKitClient } from '../../core/client.js';
import { recordError } from '../../core/exceptions.js';
import { serverRoute, serverSpanOf, setServerRoute } from '../../utils/http-route.js';
import { isIgnoredRequest } from '../../core/ignore.js';
import { tracingSuppressed, untracedRequest } from '../../core/suppress.js';
import { swallow } from '../../core/guard.js';

export class EvalKitInterceptor {
  private client: EvalKitClient;

  constructor(client: EvalKitClient) {
    this.client = client;
  }

  /** The route handler's answer, recorded as the request's span; as the handler gave it when there is nothing to record. */
  intercept(executionContext: any, next: any): any {
    let traced: unknown;
    try {
      traced = this.traced(executionContext, next);
    } catch (err) {
      swallow('tracing a NestJS request', err);
    }
    return traced ?? next.handle();
  }

  private traced(executionContext: any, next: any): unknown {
    const httpCtx = executionContext?.switchToHttp?.();
    if (!httpCtx) return undefined;

    const req = httpCtx.getRequest();
    const res = httpCtx.getResponse();
    // Already untraced: the http server left out an ignored route or a probe, or the app's own scope.
    if (!req || tracingSuppressed()) return undefined;
    // Nest has routed the request by the time an interceptor runs: on Express the route is on the
    // request; on Fastify on `routeOptions.url` (`routerPath` before Fastify 4). The server span the
    // http instrumentation opened for the request is named by it too.
    const fastifyRoute = req.routeOptions?.url ?? req.routerPath;
    // A health probe or an ignored route: the handler runs untraced, and a server span already open for the
    // request is not exported.
    const knownRoute = serverRoute(req) ?? (typeof fastifyRoute === 'string' ? fastifyRoute : undefined);
    if (isIgnoredRequest(req.method, req.originalUrl ?? req.url, knownRoute)) {
      const quiet = untracedRequest(req.raw ?? req);
      const handled = otelContext.with(quiet, () => next.handle());
      if (!handled || typeof handled.subscribe !== 'function') return handled;
      return observableLike(handled, (observer: any) => otelContext.with(quiet, () => handled.subscribe(observer)));
    }
    if (req.raw) setServerRoute(req.raw, fastifyRoute);
    // On Node's http server the request already has that server span, so the interceptor records it once,
    // as the other adapters do, rather than opening a second span for the same request; the error a handler
    // fails with is recorded on that span.
    const core = serverSpanOf(req.raw ?? req);
    if (core) return observeErrors(next.handle(), core.span as unknown as Span);
    const route = serverRoute(req) ?? (typeof fastifyRoute === 'string' ? fastifyRoute : undefined);
    const traceName = `${String(req.method ?? 'GET')} ${String(route ?? req.path ?? req.url ?? '/')}`;

    const { ctx, end } = this.client.startHttpTrace(traceName, {
      method: String(req.method ?? 'GET'),
      url: String(req.originalUrl ?? req.url ?? '/'),
      headers: req.headers as Record<string, string>,
      requestBody: req.body,
    });

    const BODY_MAX = this.client.options.maxBodyBytes;
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
    if (res && typeof res.write === 'function') {
      const origWrite = res.write.bind(res);
      res.write = function (chunk: any, ...rest: any[]) {
        captureChunk(chunk);
        return origWrite(chunk, ...rest);
      };
    }
    if (res && typeof res.end === 'function') {
      const origEnd = res.end.bind(res);
      res.end = function (chunk: any, ...rest: any[]) {
        captureChunk(chunk);
        return origEnd(chunk, ...rest);
      };
    }

    const obs$ = otelContext.with(ctx, () => next.handle());

    const safeEnd = (status: 'OK' | 'ERROR', response?: { statusCode?: number; body?: unknown; error?: unknown }) => {
      try { end(status, response); } catch {  }
    };
    const subscribe = (observer: any) => otelContext.with(ctx, () => obs$.subscribe({
      next: (v: any) => observer.next?.(v),
      error: (e: any) => {
        // Nest's exception filters answer it next, so it ends this span as a response, not by escaping it.
        safeEnd('ERROR', { statusCode: errorStatus(e, res), error: e });
        observer.error?.(e);
      },
      complete: () => {
        const sc = res?.statusCode ?? 200;
        let responseBody: string | undefined;
        if (bodyChunks.length) {
          try {
            responseBody = Buffer.concat(bodyChunks).subarray(0, BODY_MAX).toString('utf-8');
          } catch {  }
        }
        safeEnd(sc >= 400 ? 'ERROR' : 'OK', { statusCode: sc, body: responseBody });
        observer.complete?.();
      },
    }));

    return observableLike(obs$, subscribe);
  }
}

/** The status Nest answers an error with: an HttpException's own, else 500. */
function errorStatus(error: any, res: any): number {
  try {
    const status = typeof error?.getStatus === 'function' ? error.getStatus() : error?.status ?? error?.statusCode;
    if (typeof status === 'number' && status >= 100 && status < 600) return status;
  } catch {
    // An exception without a readable status is a server error.
  }
  const sc = res?.statusCode;
  return typeof sc === 'number' && sc >= 400 ? sc : 500;
}

/** The handler's answer as it was, with the error it fails with recorded on `span`. */
function observeErrors(obs$: any, span: Span): any {
  try {
    if (!obs$ || typeof obs$.subscribe !== 'function') return obs$;
    const subscribe = (observer: any) => obs$.subscribe({
      next: (v: any) => observer.next?.(v),
      error: (e: any) => {
        recordError(span, e, { escaped: false });
        observer.error?.(e);
      },
      complete: () => observer.complete?.(),
    });
    return observableLike(obs$, subscribe);
  } catch (err) {
    swallow('observing a NestJS handler', err);
    return obs$;
  }
}

/**
 * The interceptor's answer, in a form Nest takes: Nest hands it to rxjs, which accepts an Observable or an
 * interop observable and fails the request with a 500 for any other object, even one with subscribe(). The
 * SDK carries no rxjs of its own, so the Observable is made with the class of the one the route handler
 * returned (the root of its class chain, as a Subject's constructor takes no subscribe function); without
 * one, an interop observable.
 */
function observableLike(source: any, subscribe: (observer: any) => any): any {
  try {
    let proto = source && typeof source === 'object' ? Object.getPrototypeOf(source) : null;
    while (proto && Object.getPrototypeOf(proto) && Object.getPrototypeOf(proto) !== Object.prototype) {
      proto = Object.getPrototypeOf(proto);
    }
    const Root = proto?.constructor;
    if (typeof Root === 'function' && Root !== Object && typeof proto.subscribe === 'function' && typeof proto.pipe === 'function') {
      const made = new Root(subscribe);
      if (made && typeof made.subscribe === 'function') return made;
    }
  } catch {

  }
  const interop: any = {
    subscribe,
    pipe: (...operators: Array<(input: any) => any>) => operators.reduce((input, op) => op(input), interop),
    '@@observable': () => interop,
  };
  const symbol = (Symbol as { observable?: symbol }).observable;
  if (typeof symbol === 'symbol') interop[symbol] = () => interop;
  return interop;
}
