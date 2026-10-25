import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

// Internal modules are not part of the public bundle; a test that needs them builds them from source.
export async function fromSource(name, contents) {
  const root = fileURLToPath(new URL('..', import.meta.url));
  const outfile = fileURLToPath(new URL(`../node_modules/.cache/evalkit-${name}/bundle.mjs`, import.meta.url));
  await build({
    stdin: { contents, resolveDir: root, loader: 'ts', sourcefile: `${name}-entry.ts` },
    bundle: true,
    platform: 'node',
    format: 'esm',
    packages: 'external',
    outfile,
    logLevel: 'error',
  });
  return import(`${outfile}?${Date.now()}`);
}
