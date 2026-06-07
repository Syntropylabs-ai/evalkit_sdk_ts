import type { EvalKitClient } from '../../core/client.js';

/**
 * APM-style auto-tracing for a NestJS app, driven by the framework's own DI
 * registry. Given a DiscoveryService, it wraps every provider/controller method
 * (of your app-layer classes) with traceFunction — so each call becomes a
 * function_call span (`Class.method`, input/output/latency) without decorating a
 * single class.
 *
 * Kept dependency-free: the DiscoveryService is passed in as a structural type,
 * so the SDK never imports `@nestjs/*`.
 */

const SKIP = new Set([
  'constructor',
  'onModuleInit',
  'onModuleDestroy',
  'onApplicationBootstrap',
  'onApplicationShutdown',
  'beforeApplicationShutdown',
  'configure',
  // Framework contract methods — these are invoked by NestJS/Passport with a
  // specific calling convention (arity, `this`, return shape). Wrapping them
  // breaks auth, guards, pipes, interceptors, and filters. NEVER trace them.
  'validate',        // Passport strategy verify callback (auth!)
  'authenticate',    // Passport strategy
  'serializeUser',
  'deserializeUser',
  'canActivate',     // guards
  'intercept',       // interceptors
  'transform',       // pipes
  'catch',           // exception filters
  'use',             // middleware
]);

// Only trace your own app layers; keeps framework internals out of the trace.
// NOTE: `Strategy` is intentionally excluded — Passport auth strategies end in
// `Strategy` and wrapping their `validate()` breaks authentication. Guards
// (`*Guard`) are also excluded for the same reason.
const DEFAULT_CLASS_RE = /(Service|Controller|Gateway|Resolver|Repository|UseCase|Handler)$/;

type DiscoveryLike = {
  getProviders: () => Array<{ instance?: unknown }>;
  getControllers: () => Array<{ instance?: unknown }>;
};

export function autoTraceNest(
  client: EvalKitClient,
  discovery: DiscoveryLike,
  options?: { include?: RegExp; captureIO?: boolean },
): number {
  const re = options?.include ?? DEFAULT_CLASS_RE;
  const captureIO = options?.captureIO ?? true;
  const seen = new Set<unknown>();
  let methods = 0;

  const wrappers = [...discovery.getProviders(), ...discovery.getControllers()];
  for (const w of wrappers) {
    const instance = w?.instance as Record<string, unknown> | undefined;
    if (!instance || typeof instance !== 'object') continue;

    const className = (instance.constructor as { name?: string })?.name ?? '';
    if (!re.test(className)) continue;

    const proto = Object.getPrototypeOf(instance);
    if (!proto || proto === Object.prototype || seen.has(proto)) continue;
    seen.add(proto);

    for (const name of Object.getOwnPropertyNames(proto)) {
      if (SKIP.has(name)) continue;
      const desc = Object.getOwnPropertyDescriptor(proto, name);
      if (!desc || typeof desc.value !== 'function' || desc.get || desc.set) continue;
      if ((desc.value as { __evalkitTraced?: boolean }).__evalkitTraced) continue;

      const original = desc.value as (...args: unknown[]) => unknown;
      const traced = client.traceFunction(`${className}.${name}`, original, undefined, captureIO);
      (traced as { __evalkitTraced?: boolean }).__evalkitTraced = true;
      Object.defineProperty(proto, name, { ...desc, value: traced });
      methods++;
    }
  }
  return methods;
}
