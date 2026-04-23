// Step 1: Validate --project-dir + Node version pre-check.
// Fails fast (no writes, no network). Always re-runs (cheap).

import { isAbsolute, resolve } from 'node:path';

import { MysecondError } from '../errors.js';
import { isForbiddenProjectDir } from '../mysecond-paths.js';

import type { StepFn } from './types.js';

const MIN_NODE_MAJOR = 18;

function parseNodeMajor(version: string): number | null {
  // process.versions.node looks like "20.11.1" — no leading "v".
  const match = /^(\d+)\./.exec(version);
  if (match === null || match[1] === undefined) return null;
  const n = Number(match[1]);
  return Number.isFinite(n) ? n : null;
}

export const step1: StepFn = async ({ ctx }) => {
  const major = parseNodeMajor(process.versions.node);
  if (major === null || major < MIN_NODE_MAJOR) {
    // CTO-6 / HoD-4b: exit BEFORE any network/IO. bin/mysecond.cjs has its own
    // shebang guard but PATH oddities (nvm + system node) can route around it,
    // so we re-check here.
    throw MysecondError.nodeTooOld(process.versions.node);
  }

  const root = isAbsolute(ctx.rootDir) ? ctx.rootDir : resolve(process.cwd(), ctx.rootDir);
  if (isForbiddenProjectDir(root)) {
    throw MysecondError.localStateConflict(
      `--project-dir=${root} refused (path traversal / system dir guard)`
    );
  }

  return { step: 1, outcome: { kind: 'completed' } };
};
