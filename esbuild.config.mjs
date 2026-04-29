import { readFileSync } from 'node:fs';
import { build } from 'esbuild';

const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'));

// Runtime CommonJS deps that esbuild's ESM bundler can't handle (they use
// dynamic `require('path')` etc. internally). Externalized so Node's runtime
// resolver loads them from node_modules at exec time. Listed in
// package.json `dependencies` so npm installs them for the customer.
const RUNTIME_EXTERNALS = ['proper-lockfile', 'tar'];

await build({
  entryPoints: ['src/index.ts'],
  bundle: true,
  platform: 'node',
  target: 'node18',
  format: 'esm',
  outfile: 'dist/mysecond.mjs',
  external: RUNTIME_EXTERNALS,
  // ESM banner: shim createRequire so any remaining bundled-CJS uses can call
  // require() under ESM. Belt-and-suspenders alongside `external` above.
  banner: {
    js: [
      "import { createRequire as __mysecondCreateRequire } from 'node:module';",
      "const require = __mysecondCreateRequire(import.meta.url);",
    ].join('\n'),
  },
  // Bake version at build time — avoids fs read + JSON.parse on every invocation
  // and removes a runtime dependency on the package.json layout.
  define: {
    __VERSION__: JSON.stringify(pkg.version),
  },
  logLevel: 'info',
});
