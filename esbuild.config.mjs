import { build } from 'esbuild';

await build({
  entryPoints: ['src/index.ts'],
  bundle: true,
  platform: 'node',
  target: 'node18',
  format: 'esm',
  outfile: 'dist/mysecond.mjs',
  // Sentry v8 pulls in optional native modules (@sentry/profiling-node) on some
  // platforms; esbuild chokes on .node binaries. Externalize so npm resolves it
  // at install time on the customer's actual platform.
  external: ['@sentry/node'],
  // Inject ESM banner so the bundle declares its module shape clearly when run.
  banner: {
    js: '// @mysecond/cli — bundled by esbuild',
  },
  logLevel: 'info',
});
