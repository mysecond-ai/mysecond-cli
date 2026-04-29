// Step 5: Write `.env`. Append-only if exists; skip if key-value identical;
// exit 2 with `--fix` prompt if key-value conflicts.
// Spec §6.2 step 5 + §6.5 conflict resolution copy.

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline/promises';

import { atomicWriteFile } from '../atomic-write.js';
import { fixPromptEnvConflict } from '../copy.js';
import { MysecondError } from '../errors.js';

import type { StepFn } from './types.js';

const ENV_KEY = 'COMPANION_API_KEY';
const PROMPT_TIMEOUT_MS = 30_000;

interface EnvFile {
  raw: string;
  hasKey: boolean;
  currentValue: string | null;
}

function readEnv(envPath: string): EnvFile {
  if (!existsSync(envPath)) {
    return { raw: '', hasKey: false, currentValue: null };
  }
  const raw = readFileSync(envPath, 'utf8');
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (trimmed.startsWith(`${ENV_KEY}=`) || trimmed.startsWith(`export ${ENV_KEY}=`)) {
      const eqIdx = trimmed.indexOf('=');
      const value = trimmed.slice(eqIdx + 1).replace(/^["']|["']$/g, '').trim();
      return { raw, hasKey: true, currentValue: value };
    }
  }
  return { raw, hasKey: false, currentValue: null };
}

function writeKeyAppended(envFile: EnvFile, newValue: string): string {
  const separator = envFile.raw.length === 0 || envFile.raw.endsWith('\n') ? '' : '\n';
  return `${envFile.raw}${separator}${ENV_KEY}=${newValue}\n`;
}

function writeKeyReplaced(envFile: EnvFile, newValue: string): string {
  const lines = envFile.raw.split('\n');
  return lines
    .map((line) => {
      const trimmed = line.trim();
      if (trimmed.startsWith(`${ENV_KEY}=`) || trimmed.startsWith(`export ${ENV_KEY}=`)) {
        return `${ENV_KEY}=${newValue}`;
      }
      return line;
    })
    .join('\n');
}

async function promptOverwrite(currentValue: string, newValue: string): Promise<boolean> {
  if (!process.stdin.isTTY) {
    // Non-interactive caller without --fix can't be prompted; default-N.
    return false;
  }
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  process.stdout.write(fixPromptEnvConflict(currentValue, newValue) + ' ');

  const answer = await Promise.race([
    rl.question(''),
    new Promise<string>((resolve) => setTimeout(() => resolve('n'), PROMPT_TIMEOUT_MS)),
  ]);
  rl.close();
  return /^y(es)?$/i.test(answer.trim());
}

export const step5: StepFn = async ({ ctx }) => {
  const envPath = join(ctx.rootDir, '.env');
  const newValue = ctx.apiKey;
  if (newValue.length === 0) {
    throw new MysecondError(1, 'Cannot write .env: COMPANION_API_KEY is empty.');
  }

  const envFile = readEnv(envPath);

  if (envFile.hasKey && envFile.currentValue === newValue) {
    return { step: 5, outcome: { kind: 'completed' } };
  }

  if (!envFile.hasKey) {
    const next = writeKeyAppended(envFile, newValue);
    atomicWriteFile(envPath, next, { mode: 0o600 });
    return { step: 5, outcome: { kind: 'completed' } };
  }

  // Conflict path: existing key, different value.
  if (!ctx.fix) {
    throw MysecondError.localStateConflict(
      `.env has a conflicting ${ENV_KEY}. Run with --fix to resolve interactively, or email support@mysecond.ai`
    );
  }

  const overwrite = await promptOverwrite(envFile.currentValue ?? '', newValue);
  if (!overwrite) {
    throw new MysecondError(2, 'Conflict resolution declined. Re-run with --fix to retry.');
  }

  const next = writeKeyReplaced(envFile, newValue);
  atomicWriteFile(envPath, next, { mode: 0o600 });
  return { step: 5, outcome: { kind: 'completed' } };
};
