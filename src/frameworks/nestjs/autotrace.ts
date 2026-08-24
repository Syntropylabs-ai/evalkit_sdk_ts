import type { EvalKitClient } from '../../core/client.js';

const SKIP = new Set([
  'constructor',
  'onModuleInit',
  'onModuleDestroy',
  'onApplicationBootstrap',
  'onApplicationShutdown',
  'beforeApplicationShutdown',
  'configure',

  'validate',
  'authenticate',
  'serializeUser',
  'deserializeUser',
  'canActivate',
  'intercept',
  'transform',
  'catch',
  'use',
]);

const DEFAULT_CLASS_RE = /(Service|Controller|Gateway|Resolver|Repository|UseCase|Handler)$/;

type DiscoveryLike = {
  getProviders: () => Array<{ instance?: unknown }>;
  getControllers: () => Array<{ instance?: unknown }>;
};

function copyReflectMetadata(from: object, to: object): void {
  const R = (globalThis as { Reflect?: any }).Reflect as any;
  if (!R || typeof R.defineMetadata !== 'function') return;
  const getKeys = typeof R.getOwnMetadataKeys === 'function' ? R.getOwnMetadataKeys : R.getMetadataKeys;
  const getMeta = typeof R.getOwnMetadata === 'function' ? R.getOwnMetadata : R.getMetadata;
  if (typeof getKeys !== 'function' || typeof getMeta !== 'function') return;
  let keys: unknown[] = [];
  try { keys = getKeys.call(R, from) || []; } catch { return; }
  for (const key of keys) {
    try { R.defineMetadata(key, getMeta.call(R, key, from), to); } catch {  }
  }
}

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

      copyReflectMetadata(original, traced);
      try { Object.defineProperty(traced, 'name', { value: name, configurable: true }); } catch {  }
      try { Object.defineProperty(traced, 'length', { value: original.length, configurable: true }); } catch {  }

      (traced as { __evalkitTraced?: boolean }).__evalkitTraced = true;
      Object.defineProperty(proto, name, { ...desc, value: traced });
      methods++;
    }
  }
  return methods;
}
