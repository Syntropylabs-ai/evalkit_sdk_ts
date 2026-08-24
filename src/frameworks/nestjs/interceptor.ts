import { context as otelContext } from '@opentelemetry/api';
import type { EvalKitClient } from '../../core/client.js';

export class EvalKitInterceptor {
  private client: EvalKitClient;

  constructor(client: EvalKitClient) {
    this.client = client;
  }

  intercept(executionContext: any, next: any): any {
    const httpCtx = executionContext.switchToHttp?.();
    if (!httpCtx) return next.handle();

    const req = httpCtx.getRequest();
    const res = httpCtx.getResponse();
    const traceName = `${String(req.method ?? 'GET')} ${String(req.route?.path ?? req.path ?? req.url ?? '/')}`;

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

    return {
      subscribe(observer: any) {
        return obs$.subscribe({
          next: (v: any) => observer.next?.(v),
          error: (e: any) => {
            end('ERROR');
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
            end(sc >= 400 ? 'ERROR' : 'OK', { statusCode: sc, body: responseBody });
            observer.complete?.();
          },
        });
      },
      pipe(...args: any[]) {
        return obs$.pipe(...args);
      },
    };
  }
}
