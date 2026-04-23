// Step 6: Write `.claude/settings.json` env block — only the
// SLASH_COMMAND_TOOL_CHAR_BUDGET=20000 key. Hooks live in plugin manifest per
// CAIO-Y1 (v1.3); this step now only writes the env block. Spec §6.3a merge
// rules: single-key update, preserve all other env entries verbatim,
// customer-authored value wins on conflict (PostHog event fires; no override).

import { existsSync, readFileSync } from 'node:fs';

import { atomicWriteFile } from '../atomic-write.js';
import { projectPaths } from '../files.js';

import type { StepFn } from './types.js';

const ENV_KEY = 'SLASH_COMMAND_TOOL_CHAR_BUDGET';
const ENV_VALUE = '20000';

interface SettingsShape {
  env?: Record<string, string>;
  [key: string]: unknown;
}

function readSettings(path: string): SettingsShape {
  if (!existsSync(path)) return {};
  try {
    const raw = readFileSync(path, 'utf8');
    if (raw.trim().length === 0) return {};
    const parsed = JSON.parse(raw) as unknown;
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {};
    return parsed as SettingsShape;
  } catch {
    return {};
  }
}

export const step6: StepFn = async ({ ctx }) => {
  const settingsPath = projectPaths(ctx.rootDir).syncStatePath.replace(
    /sync-state\.json$/,
    'settings.json'
  );

  const settings = readSettings(settingsPath);
  const env = { ...(settings.env ?? {}) };

  // Idempotency: matching value → no-op.
  if (env[ENV_KEY] === ENV_VALUE) {
    return { step: 6, outcome: { kind: 'completed' } };
  }

  // Conflict (customer-authored different value): preserve customer's value,
  // log conflict, continue. Spec §6.3a — customer wins.
  if (env[ENV_KEY] !== undefined && env[ENV_KEY] !== ENV_VALUE) {
    if (!ctx.silent) {
      process.stderr.write(
        `mysecond: noted .claude/settings.json env.${ENV_KEY}=${env[ENV_KEY]} (customer value preserved over our default ${ENV_VALUE})\n`
      );
    }
    return { step: 6, outcome: { kind: 'completed' } };
  }

  env[ENV_KEY] = ENV_VALUE;
  const next: SettingsShape = { ...settings, env };
  atomicWriteFile(settingsPath, JSON.stringify(next, null, 2) + '\n', { mkdirRecursive: true });
  return { step: 6, outcome: { kind: 'completed' } };
};
