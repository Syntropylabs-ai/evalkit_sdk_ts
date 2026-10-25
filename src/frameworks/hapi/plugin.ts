import { context as otelContext } from '@opentelemetry/api';
import type { EvalKitClient } from '../../core/client.js';
import { boundedText } from '../../core/serialize.js';
import { extractTraceparent } from '../../core/context.js';
import { serverSpanOf, setServerName, setServerRoute } from '../../utils/http-route.js';
import { isIgnoredRequest } from '../../core/ignore.js';
import { dropSpan, tracingSuppressed } from '../../core/suppress.js';

export interface HapiPluginOptions {
  name?: string | ((request: any) => string);
}

export function createHapiPlugin(
  client: EvalKitClient,
  options?: HapiPluginOptions,
): { name: string; register: (server: any) => void } {
  return {
    name: '@evalkit/hapi',
    register(server: any) {

      const requestEndMap = new WeakMap<object, {
        end: (...args: any[]) => void;
        ctx: any;
      }>();

      server.ext('onRequest', (request: any, h: any) => {
        // Already untraced: the http server left out an ignored route or a probe.
        if (tracingSuppressed()) return h.continue;
        // A health probe or an ignored route is not recorded. hapi runs the rest of the request outside this
        // hook, so instead of a suppressed context the server span the http server opened is dropped, and with
        // it every span started under it.
        const route = request.route?.method !== '_special' ? request.route?.path : undefined;
        if (isIgnoredRequest(request.method, request.path, route)) {
          const core = serverSpanOf(request.raw?.req);
          if (core) dropSpan(core.span);
          return h.continue;
        }

        const traceName = typeof options?.name === 'function'
          ? options.name(request)
          : (options?.name ?? `${String(request.method?.toUpperCase() ?? 'GET')} ${String(request.path ?? '/')}`);

        // On Node's http server the request already has its server span; the plugin names that one, by the
        // route hapi matched, rather than recording the request a second time.
        if (serverSpanOf(request.raw?.req)) {
          if (options?.name !== undefined) setServerName(request.raw.req, traceName);
          return h.continue;
        }

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
        // hapi answers an unmatched request through its own catch-all route, which names nothing.
        if (request.route?.method !== '_special') setServerRoute(request.raw?.req, request.route?.path);
        const entry = requestEndMap.get(request);
        if (entry) {
          const sc = request.response?.output?.statusCode ??
            request.response?.statusCode ??
            200;
          let responseBody: string | undefined;
          try {
            const src = request.response?.source ?? request.response?.result;
            if (src !== undefined && src !== null) {
              responseBody = typeof src === 'string' ? src.slice(0, client.options.maxBodyBytes) : boundedText(src, client.options.maxBodyBytes);
            }
          } catch {  }
          // hapi answers a failed handler with a Boom error, which carries the original error's message.
          const error = request.response?.isBoom ? request.response : undefined;
          try {
            entry.end(sc >= 400 ? 'ERROR' : 'OK', { statusCode: sc, body: responseBody, ...(error ? { error } : {}) });
          } catch {  }
          requestEndMap.delete(request);
        }
        return h.continue;
      });
    },
  };
}
