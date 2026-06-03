import { createRequire } from 'module';

// Prevents esbuild from transforming import() → require() in CJS build.
// Keeps it as a true runtime dynamic import so ESM module cache is used.
export const dynImport = new Function('s', 'return import(s)') as (s: string) => Promise<any>;

export function loadIfAlreadyRequired(name: string): any {
  // In ESM apps (type: "module"), require and require.cache are undefined — returns null.
  if (typeof require === 'undefined') return null;
  const cache = (require as NodeRequire).cache;
  if (!cache) return null;
  const hit = Object.keys(cache).find((k) => {
    const segments = k.split('/node_modules/');
    return segments.length > 1 && segments[segments.length - 1].startsWith(name + '/');
  });
  return hit ? cache[hit]?.exports ?? null : null;
}

export function getRequire(): NodeRequire {
  return typeof require !== 'undefined' ? require : createRequire(import.meta.url);
}
