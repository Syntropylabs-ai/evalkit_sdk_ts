import { context as otelContext, trace as otelTrace } from '@opentelemetry/api';
import type { EvalKitClient } from '../../core/client.js';
import { extractTraceparent } from '../../core/context.js';

export interface ExpressMiddlewareOptions {
  name?: string | ((req: any) => string);
}

export function createExpressMiddleware(
  client: EvalKitClient,
  options?: ExpressMiddlewareOptions,
): (req: any, res: any, next: any) => void {
  return (req: any, res: any, next: any) => {
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

    // Inject trace_id into response so clients can correlate.
    const spanId = otelTrace.getSpan(ctx)?.spanContext().spanId ?? '0000000000000000';
    res.setHeader?.('x-trace-id', traceId);
    res.setHeader?.('traceparent', `00-${traceId}-${spanId}-01`);

    const origEnd = res.end as (...args: any[]) => any;
    res.end = function (...args: any[]) {
      const sc = (res.statusCode as number) ?? 200;
      end(sc >= 400 ? 'ERROR' : 'OK', {
        statusCode: sc,
        headers: res.getHeaders ? res.getHeaders() as Record<string, string> : undefined,
      });
      return origEnd.apply(res, args);
    };

    otelContext.with(ctx, () => next());
  };
}
