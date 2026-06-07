import { context as otelContext } from '@opentelemetry/api';
import type { EvalKitClient } from '../../core/client.js';
import { extractTraceparent } from '../../core/context.js';

export interface HapiPluginOptions {
  name?: string | ((request: any) => string);
}

/**
 * Hapi lifecycle plugin that auto-traces every incoming request.
 *
 * @example
 * import Hapi from '@hapi/hapi';
 * import evalkit from 'syntropylabs-evalkit';
 *
 * evalkit.init({ subscriptionKey: '...', serviceName: 'my-api' });
 * const server = Hapi.server({ port: 3000 });
 * await server.register(evalkit.hapiPlugin());
 */
export function createHapiPlugin(
  client: EvalKitClient,
  options?: HapiPluginOptions,
): { name: string; register: (server: any) => void } {
  return {
    name: '@evalkit/hapi',
    register(server: any) {
      // Map to store per-request end callbacks
      const requestEndMap = new WeakMap<object, {
        end: (...args: any[]) => void;
        ctx: any;
      }>();

      server.ext('onRequest', (request: any, h: any) => {
        const traceName = typeof options?.name === 'function'
          ? options.name(request)
          : (options?.name ?? `${String(request.method?.toUpperCase() ?? 'GET')} ${String(request.path ?? '/')}`);

        const parentCtx = extractTraceparent(
          request.headers?.['traceparent'] as string | undefined
        );

        const { end, ctx } = otelContext.with(parentCtx, () =>
          client.startHttpTrace(traceName, {
            method: String(request.method?.toUpperCase() ?? 'GET'),
            url: String(request.url?.href ?? request.path ?? '/'),
            headers: request.headers as Record<string, string>,
          })
        );

        requestEndMap.set(request, { end, ctx });
        return h.continue;
      });

      server.ext('onPreResponse', (request: any, h: any) => {
        const entry = requestEndMap.get(request);
        if (entry) {
          const sc = request.response?.output?.statusCode ??
            request.response?.statusCode ??
            200;
          let responseBody: string | undefined;
          try {
            const src = request.response?.source ?? request.response?.result;
            if (src !== undefined && src !== null) {
              responseBody = (typeof src === 'string' ? src : JSON.stringify(src)).slice(0, 4096);
            }
          } catch { /* ignore */ }
          entry.end(sc >= 400 ? 'ERROR' : 'OK', { statusCode: sc, body: responseBody });
          requestEndMap.delete(request);
        }
        return h.continue;
      });
    },
  };
}
