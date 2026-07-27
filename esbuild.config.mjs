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

// ── Standalone (fallback-installer) target — install-wall plan ──────────────
//
// FULLY self-contained: `external: []` bundles proper-lockfile + tar too.
// Served from app.mysecond.ai by install.sh for customers whose npm/npx is
// broken (corp registries, poisoned .npmrc, TLS interception) — on those
// machines there IS no `npm install`, so runtime externals would crash at
// first `require('tar')` (verified: the default dist/ died in a bare-Node
// container exactly that way). The createRequire banner satisfies the CJS
// deps' internal dynamic `require(...)` calls under ESM.
//
// Output goes to dist-standalone/ — deliberately OUTSIDE package.json
// `files` (["dist/", "bin/"]) so the published npm package is byte-unchanged
// by this target. Runnable directly: `node mysecond-standalone.mjs init …`
// (the entry self-executes `main(process.argv)`).
//
// MUST pass the bare-Node Docker smoke (Layer-2 script) before any tarball
// upload — bundling-CJS-under-ESM is exactly the kind of thing that works on
// a dev machine with node_modules present and fails without it.
await build({
  entryPoints: ['src/index.ts'],
  bundle: true,
  platform: 'node',
  target: 'node18',
  format: 'esm',
  outfile: 'dist-standalone/mysecond-standalone.mjs',
  external: [],
  banner: {
    js: [
      "import { createRequire as __mysecondCreateRequire } from 'node:module';",
      "const require = __mysecondCreateRequire(import.meta.url);",
    ].join('\n'),
  },
  define: {
    __VERSION__: JSON.stringify(pkg.version),
  },
  logLevel: 'info',
});
