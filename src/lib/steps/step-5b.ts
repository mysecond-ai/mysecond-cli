// Step 5b: Project-scoped credential write + migration + gitignore guard.
//
// Companion to step-5 (which writes `.env`). Adds three things:
//
//   1. Dual-write the COMPANION_API_KEY to
//      `~/.mysecond/projects/<sha256(rootDir)/8>/credentials` (chmod 600).
//      Customer plugin hooks read this path BEFORE `.env` so multiple PM OS
//      folders on one machine each have their own key (project .env
//      remains as backward-compat for customers on older hooks; v1.4.0
//      drops the .env write entirely).
//
//   2. Silent MIGRATION on every init run. If `.env` had the key but the
//      project-scoped file is missing/empty, copy the key over. Idempotent.
//      Drift case (project-scoped already has a DIFFERENT key): SKIP
//      overwrite — assume the customer manually edited; the hook's
//      shipped dual-creds warning will surface the mismatch on next run.
//
//   3. Security mitigation: ensure `.env` is in `<rootDir>/.gitignore` so
//      the customer can't accidentally commit their API key. Skipped if the
//      project isn't a git repo (don't pollute non-repo folders). LOUD
//      warning if `.env` is already tracked (gitignore rules don't apply
//      retroactively — the key is already in git history).
//
// Platform: skipped on Windows. The path computation is portable but the
// chmod 600 contract isn't reliably enforced on NTFS, so we explicitly skip
// + log rather than ship a silent half-fix. v1.4.0 may revisit.

import { existsSync, mkdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { atomicWriteFile } from '../atomic-write.js';
import { getProjectScopedCredsDir, getProjectScopedCredsPath } from '../creds-path.js';
import { ensureGitignoreEntry, isFileTracked, isGitRepo } from '../git-helpers.js';

import type { StepFn } from './types.js';

const ENV_KEY = 'COMPANION_API_KEY';

interface CredsContent {
  hasKey: boolean;
  currentValue: string | null;
}

function readProjectScopedCreds(path: string): CredsContent {
  if (!existsSync(path)) return { hasKey: false, currentValue: null };
  try {
    const raw = readFileSync(path, 'utf8');
    for (const line of raw.split('\n')) {
      const trimmed = line.trim();
      if (trimmed.startsWith(`${ENV_KEY}=`)) {
        const eqIdx = trimmed.indexOf('=');
        const value = trimmed
          .slice(eqIdx + 1)
          .replace(/^["']|["']$/g, '')
          .trim();
        return { hasKey: true, currentValue: value };
      }
    }
    return { hasKey: false, currentValue: null };
  } catch {
    return { hasKey: false, currentValue: null };
  }
}

function emit(silent: boolean, message: string): void {
  if (silent) return;
  process.stdout.write(`${message}\n`);
}

function emitWarning(silent: boolean, message: string): void {
  // Warnings always go to stderr regardless of --silent so security-critical
  // info isn't suppressed. (--silent is for happy-path noise.)
  process.stderr.write(`${message}\n`);
  // Also dup to stdout when not silent so the user sees it inline with the
  // success-output stream, not just buried in stderr.
  if (!silent) process.stdout.write(`${message}\n`);
}

export const step5b: StepFn = async ({ ctx }) => {
  // Windows guard — explicit skip + log per CTO review.
  if (process.platform === 'win32') {
    emit(
      ctx.silent,
      '[mysecond] Skipping project-scoped credential storage on Windows — your .env workflow is unchanged. (Tracking: this will be revisited in v1.4.0+.)'
    );
    return { step: 14, outcome: { kind: 'completed' } };
  }

  const newKey = ctx.apiKey;
  if (newKey.length === 0) {
    // Should never happen — step-5 already enforces non-empty. Defensive no-op.
    return { step: 14, outcome: { kind: 'completed' } };
  }

  const credsDir = getProjectScopedCredsDir(ctx.rootDir);
  const credsPath = getProjectScopedCredsPath(ctx.rootDir);

  // Create parent dir with mode 0o700 so other same-machine users can't
  // list project hashes (information leak — credential file is 0o600 already).
  let dirCreated = false;
  try {
    if (!existsSync(credsDir)) {
      mkdirSync(credsDir, { recursive: true, mode: 0o700 });
      dirCreated = true;
    }
  } catch (err) {
    // Filesystem write failure is recoverable — the .env path still works.
    // Don't crash the install; surface a warning so the customer knows the
    // security upgrade didn't apply.
    emitWarning(
      ctx.silent,
      `[mysecond] ⚠️ Could not create ${credsDir} (${(err as Error).message}). Falling back to .env-only credential storage. Sync still works; security upgrade did not apply.`
    );
    return { step: 14, outcome: { kind: 'completed' } };
  }

  // Read current state.
  const existing = readProjectScopedCreds(credsPath);
  const isMigration =
    !existing.hasKey && existsSync(join(ctx.rootDir, '.env'));

  // Idempotent: if project-scoped already has the right key, skip the write.
  if (existing.hasKey && existing.currentValue === newKey) {
    // Still run the gitignore guard below — that's not idempotency-gated.
  } else if (existing.hasKey && existing.currentValue !== newKey) {
    // Drift case: project-scoped has a DIFFERENT key. Don't overwrite;
    // assume the customer manually edited. Hook's dual-creds warning
    // (shipped in product-manager-os PR #13) will surface the mismatch.
    emitWarning(
      ctx.silent,
      `[mysecond] ⚠️ ${credsPath} has a different COMPANION_API_KEY than the one provided. Skipping overwrite — manual edit assumed. Run \`mysecond whereami\` to inspect, or delete the file to let init re-write.`
    );
  } else {
    // Write (atomic via temp+rename) with mode 0o600.
    try {
      atomicWriteFile(credsPath, `${ENV_KEY}=${newKey}\n`, { mode: 0o600 });
    } catch (err) {
      emitWarning(
        ctx.silent,
        `[mysecond] ⚠️ Could not write ${credsPath} (${(err as Error).message}). Falling back to .env-only credential storage.`
      );
      return { step: 14, outcome: { kind: 'completed' } };
    }

    // chmod-failure check: confirm the file is actually 0o600. Loud security
    // warning if not (per CAIO review — silent fallback hides risk).
    try {
      const mode = statSync(credsPath).mode & 0o777;
      if (mode !== 0o600) {
        emitWarning(
          ctx.silent,
          `[mysecond] ⚠️ ${credsPath} is mode ${mode.toString(8)}, expected 600. Other users on this machine may be able to read your API key. Run \`chmod 600\` to fix.`
        );
      }
    } catch {
      // statSync errors are non-fatal here — ignore.
    }

    if (isMigration) {
      emit(
        ctx.silent,
        '[mysecond] Secured your API key: moved out of .env (which can leak into git history) into a global file. Run `mysecond whereami` to see where your credentials live.'
      );
    } else if (dirCreated) {
      emit(
        ctx.silent,
        '[mysecond] Wrote project-scoped credential storage. Run `mysecond whereami` to see where your credentials live.'
      );
    }
  }

  // ── Gitignore guard ─────────────────────────────────────────────────────
  // Gate on .git existence — non-repo folders shouldn't get a stray .gitignore.
  if (isGitRepo(ctx.rootDir)) {
    // Check tracked-status FIRST. If `.env` is already in git's index,
    // appending to .gitignore is a security-theatre no-op — the key is
    // already in committed history. Surface a loud warning so the customer
    // knows to remediate (git rm --cached + commit + key rotation).
    if (isFileTracked(ctx.rootDir, '.env')) {
      emitWarning(
        ctx.silent,
        '[mysecond] ⚠️ SECURITY: .env is tracked by git in this repo. Your COMPANION_API_KEY is in your git history right now. Remediate:\n' +
          '  1. git rm --cached .env\n' +
          '  2. git commit -m "stop tracking .env"\n' +
          '  3. Rotate your key at app.mysecond.ai (the old key is in git history forever).\n' +
          '  4. Re-run `mysecond init` with the new key.'
      );
    } else {
      // Pre-write notice + ensure entry. Customer-empathy per CAIO review:
      // print BEFORE mutating, not after.
      const path = join(ctx.rootDir, '.gitignore');
      const willMutate =
        !existsSync(path) ||
        !readFileSync(path, 'utf8')
          .split('\n')
          .map((l) => l.trim())
          .includes('.env');
      if (willMutate) {
        emit(ctx.silent, '[mysecond] Adding `.env` to .gitignore as a safety net.');
      }
      try {
        ensureGitignoreEntry(ctx.rootDir, '.env');
      } catch (err) {
        emitWarning(
          ctx.silent,
          `[mysecond] ⚠️ Could not update .gitignore (${(err as Error).message}). Add \`.env\` manually so your API key isn't committed.`
        );
      }
    }
  }

  return { step: 14, outcome: { kind: 'completed' } };
};
