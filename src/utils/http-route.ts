/**
 * The route template of an incoming request (`/orders/:id`), which names its server span: the raw
 * path puts every id in the name, so each order or charge became an operation of its own.
 */

const SERVER_ROUTE = Symbol.for('evalkit.http.route');

/**
 * Record the route a framework matched on the Node request it is serving, for the server span the
 * http instrumentation opened before the framework saw the request. Fastify and NestJS on Fastify
 * keep their route on their own request object, so their adapters pass `request.raw` here.
 */
export function setServerRoute(req: unknown, route: unknown): void {
  if (!req || typeof req !== 'object' || typeof route !== 'string' || !route.startsWith('/')) return;
  try {
    (req as Record<symbol, unknown>)[SERVER_ROUTE] = route;
  } catch {

  }
}

/**
 * The template of the route that served `req`, or undefined when no framework matched one (a 404,
 * or a bare http server). Express (and NestJS on Express) leaves the matched route on the request:
 * `req.route.path` relative to the router, mounted at `req.baseUrl`.
 */
export function serverRoute(req: unknown): string | undefined {
  if (!req || typeof req !== 'object') return undefined;
  try {
    const recorded = (req as Record<symbol, unknown>)[SERVER_ROUTE];
    if (typeof recorded === 'string') return recorded;
    const r = req as { route?: { path?: unknown }; baseUrl?: unknown };
    const path = r.route?.path;
    if (typeof path !== 'string' || !path.startsWith('/')) return undefined;
    const base = typeof r.baseUrl === 'string' ? r.baseUrl.replace(/\/$/, '') : '';
    const joined = path === '/' && base ? base : `${base}${path}`;
    return joined || '/';
  } catch {
    return undefined;
  }
}

/** An outbound HTTP span's name: the method alone, as OpenTelemetry names a client span whose URL template is unknown. The URL stays in `http.url`. */
export function clientSpanName(method: string | undefined): string {
  return (method || 'GET').toUpperCase();
}

const SERVER_SPAN = Symbol.for('evalkit.http.server_span');
const SERVER_NAME = Symbol.for('evalkit.http.server_name');

export interface ServerSpanRef {
  span: { updateName(name: string): unknown; setAttribute(key: string, value: string): unknown };
  ctx: unknown;
}

/** Notes on a Node request the server span the http instrumentation opened for it. */
export function markServerSpan(req: unknown, ref: ServerSpanRef): void {
  if (!req || typeof req !== 'object') return;
  try {
    Object.defineProperty(req, SERVER_SPAN, { value: ref, configurable: true });
  } catch {

  }
}

/**
 * The server span already recording `req`, if the http instrumentation opened one. A framework adapter
 * then names and enriches that span instead of opening a second one for the same request.
 */
export function serverSpanOf(req: unknown): ServerSpanRef | undefined {
  if (!req || typeof req !== 'object') return undefined;
  try {
    return (req as Record<symbol, ServerSpanRef | undefined>)[SERVER_SPAN];
  } catch {
    return undefined;
  }
}

/** A name an adapter's `name` option gives the request's server span, kept over the route template. */
export function setServerName(req: unknown, name: unknown): void {
  if (!req || typeof req !== 'object' || typeof name !== 'string' || !name) return;
  try {
    (req as Record<symbol, unknown>)[SERVER_NAME] = name;
  } catch {

  }
}

export function serverName(req: unknown): string | undefined {
  if (!req || typeof req !== 'object') return undefined;
  try {
    const name = (req as Record<symbol, unknown>)[SERVER_NAME];
    return typeof name === 'string' ? name : undefined;
  } catch {
    return undefined;
  }
}
