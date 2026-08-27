import { createRequire } from 'module';

export const dynImport = new Function('s', 'return import(s)') as (s: string) => Promise<any>;

let sdkRequire: NodeRequire | undefined;

function localRequire(): NodeRequire {
  if (!sdkRequire) sdkRequire = createRequire(import.meta.url);
  return sdkRequire;
}

export function requireBuiltin<T = any>(name: string): T {
  return localRequire()(name) as T;
}

export function getRequire(): NodeRequire {
  if (typeof require === 'undefined') throw new Error('[evalkit] no CommonJS require in this module format');
  const host = require as NodeRequire;
  host('module');
  return host;
}

export function loadIfAlreadyRequired(name: string): any {
  try {
    const cache = localRequire().cache;
    if (!cache) return null;
    const hit = Object.keys(cache).find((k) => {
      const segments = k.split('/node_modules/');
      return segments.length > 1 && segments[segments.length - 1].startsWith(name + '/');
    });
    return hit ? cache[hit]?.exports ?? null : null;
  } catch {
    return null;
  }
}
