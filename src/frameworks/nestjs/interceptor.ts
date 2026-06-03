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
    const traceName = `${String(req.method ?? 'GET')} ${String(req.route?.path ?? req.path ?? req.url ?? '/')}`;

    const { ctx, end } = this.client.startHttpTrace(traceName, {
      method: String(req.method ?? 'GET'),
      url: String(req.originalUrl ?? req.url ?? '/'),
      headers: req.headers as Record<string, string>,
      requestBody: req.body,
    });

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
            const sc = httpCtx.getResponse().statusCode ?? 200;
            end(sc >= 400 ? 'ERROR' : 'OK', { statusCode: sc });
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
