import { createRequire } from 'module';

let importer: ((s: string) => Promise<any>) | undefined;

/**
 * import() of a specifier only known at run time, hidden from bundlers that would otherwise try to resolve
 * every optional peer at build time. Made on first use: a runtime that forbids code generation from strings
 * (a Content-Security-Policy, some edge runtimes) then fails only that call, never the SDK's import.
 */
export function dynImport(s: string): Promise<any> {
  try {
    if (!importer) importer = new Function('s', 'return import(s)') as (s: string) => Promise<any>;
    return importer(s);
  } catch (err) {
    return Promise.reject(err);
  }
}

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
