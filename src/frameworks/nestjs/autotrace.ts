import type { EvalKitClient } from '../../core/client.js';
import { isUntracedProbe } from '../../core/ignore.js';
import { isUntracedFunction, untraced } from '../../core/suppress.js';

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

// The metadata key under which Nest's @Controller() and @Get()/@Post()/... decorators keep a route's path.
const PATH_METADATA = 'path';

function metadataPaths(value: unknown): string[] {
  const list = Array.isArray(value) ? value : [value];
  return list.filter((p): p is string => typeof p === 'string');
}

/**
 * Whether a controller method is the handler of a health or readiness probe route, by the paths Nest's
 * decorators recorded on the controller and on the method. A method with no route of its own is not one.
 */
function isProbeHandler(controller: unknown, handler: unknown): boolean {
  try {
    const R = (globalThis as { Reflect?: any }).Reflect as any;
    if (!R || typeof R.getMetadata !== 'function' || !controller || !handler) return false;
    const own = metadataPaths(R.getMetadata(PATH_METADATA, handler));
    if (!own.length) return false;
    const bases = metadataPaths(R.getMetadata(PATH_METADATA, controller));
    const paths = (bases.length ? bases : ['/']).flatMap((base) => own.map((path) => `/${base}/${path}`));
    return paths.every((path) => isUntracedProbe(path));
  } catch {
    return false;
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
      if (isUntracedFunction(original)) continue;
      // A probe handler runs untraced. The probe's request is not recorded, so each span opened inside it, by a
      // traced service it calls or a model or database call, would be a trace of its own on every poll.
      const probe = isProbeHandler(instance.constructor, original);
      const traced = probe ? untraced(original) : client.traceFunction(`${className}.${name}`, original, undefined, captureIO);
      // A method `ignoreFunctions` names comes back as it was and is left in place.
      if (traced === original) continue;

      copyReflectMetadata(original, traced);
      try { Object.defineProperty(traced, 'name', { value: name, configurable: true }); } catch {  }
      try { Object.defineProperty(traced, 'length', { value: original.length, configurable: true }); } catch {  }

      (traced as { __evalkitTraced?: boolean }).__evalkitTraced = true;
      Object.defineProperty(proto, name, { ...desc, value: traced });
      if (!probe) methods++;
    }
  }
  return methods;
}
