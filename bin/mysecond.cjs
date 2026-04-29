#!/usr/bin/env node
'use strict';

// CTO-6: Node version guard fires BEFORE the ESM bundle is parsed.
// Without this, customers on pre-Node-18 (common on machines where /usr/bin/node
// resolves to a system v16 ahead of nvm's v18+) get a cryptic SyntaxError from
// the ESM bundle's top-level await rather than a clear "upgrade Node" message.
// This .cjs shim uses only CommonJS primitives (process.versions, parseInt, console.error)
// so it parses cleanly on every Node version >= 0.10.
const major = parseInt(process.versions.node.split('.')[0], 10);
if (major < 18) {
  console.error(
    `mysecond requires Node 18 or newer — you're on ${process.versions.node}. ` +
      'Upgrade Node (nvm install 18 or brew upgrade node) and re-run.'
  );
  process.exit(3);
}

// Dynamic import the ESM bundle. CTO review surfaced that an unhandled rejection
// here (e.g., a top-level error in the bundle) would silently hang the binary
// with no output — a launch-day nightmare. Catch and exit non-zero with the error.
import('../dist/mysecond.mjs').catch((err) => {
  console.error('mysecond failed to start:', err && err.stack ? err.stack : err);
  process.exit(1);
});
