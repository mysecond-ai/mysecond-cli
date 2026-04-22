import { readFileSync } from 'node:fs';
import { build } from 'esbuild';

const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'));

await build({
  entryPoints: ['src/index.ts'],
  bundle: true,
  platform: 'node',
  target: 'node18',
  format: 'esm',
  outfile: 'dist/mysecond.mjs',
  // Bake version at build time — avoids fs read + JSON.parse on every invocation
  // and removes a runtime dependency on the package.json layout.
  define: {
    __VERSION__: JSON.stringify(pkg.version),
  },
  logLevel: 'info',
});
