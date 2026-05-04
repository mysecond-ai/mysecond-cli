// `mysecond doctor` — verify the install + token state.
//
// Workstream B / Phase 2a Day 3. Three states (CAIO #8 P0 spec):
//
//   1. install-state.json missing
//        Status: not installed.
//        Run: npx -y @mysecond/cli@latest init
//
//   2. install-state.json present, no token
//        Status: install incomplete.
//        Run: mysecond init --resume
//
//   3. install-state.json present, token present
//        Ping /api/companion/whoami; print connection summary.
//
// Locked decision: ship human-readable only at 2a. `--json` flag and
// /support-bundle skill land at 2b alongside Connected Devices panel.
//
// Brief: ~/.claude/plans/workstream-b-device-code-brief.md

import { existsSync } from 'node:fs';

import type { CommandContext } from '../lib/context.js';
import { getInstallStatePath, readInstallState } from '../lib/install-state.js';
import { getDeviceToken } from '../lib/keychain.js';

declare const __VERSION__: string;

interface WhoamiResponse {
  email: string | null;
  team_id: string;
  user_id: string;
  scopes: readonly string[];
}

export async function runDoctor(
  _args: readonly string[],
  ctx: CommandContext
): Promise<number> {
  const installStatePath = getInstallStatePath(ctx.rootDir);

  // ── State 1: install-state.json missing ────────────────────────────────
  if (!existsSync(installStatePath)) {
    process.stdout.write(
      [
        'Status: not installed.',
        '',
        'No install state found at:',
        `  ${installStatePath}`,
        '',
        'To install: npx -y @mysecond/cli@latest init',
        '',
      ].join('\n')
    );
    return 1;
  }

  // ── Read install state — may surface base_plugin_version drift later ───
  const state = readInstallState(ctx.rootDir);

  // ── State 2: token missing ─────────────────────────────────────────────
  const tokenResult = getDeviceToken(ctx.rootDir);
  if (tokenResult === null) {
    process.stdout.write(
      [
        'Status: install incomplete.',
        '',
        'Found install state, but no device token. The browser authorization step',
        "didn't complete or the credential was cleared.",
        '',
        'To resume: mysecond init --resume',
        '',
      ].join('\n')
    );
    return 1;
  }

  // ── State 3: ping /whoami ──────────────────────────────────────────────
  let whoami: WhoamiResponse | null = null;
  let pingError: string | null = null;
  try {
    const url = new URL('/api/companion/whoami', ctx.apiBase);
    const response = await fetch(url, {
      headers: {
        authorization: `Bearer ${tokenResult.token}`,
        'user-agent': `mysecond-cli/${__VERSION__} (${process.platform}; node-${process.versions.node})`,
      },
      signal: AbortSignal.timeout(15_000),
    });
    if (response.status === 200) {
      const body = (await response.json().catch(() => null)) as WhoamiResponse | null;
      if (body && typeof body.team_id === 'string') {
        whoami = body;
      } else {
        pingError = 'whoami returned malformed response';
      }
    } else if (response.status === 401) {
      // CXO Day 4: customer-facing copy. Don't expose status code or
      // internal "revoked" jargon — name the cause + recovery in plain
      // English.
      pingError = 'Your device was disconnected. Run `mysecond init --resume` to reconnect.';
    } else {
      pingError = `Connection check failed (status ${response.status}). Try again, or run \`mysecond init --resume\` if it persists.`;
    }
  } catch (err) {
    pingError =
      err instanceof Error
        ? `network error: ${err.message}`
        : 'network error: unknown';
  }

  // Format the report.
  const lines: string[] = ['Status: installed.', ''];
  lines.push(`  cli version:          ${__VERSION__}`);
  lines.push(`  install state:        ${installStatePath}`);
  lines.push(`  base_plugin_version:  ${state.base_plugin_version ?? 'not yet synced'}`);
  lines.push(`  files tracked:        ${Object.keys(state.files).length}`);
  lines.push(`  token storage:        ${tokenResult.storage}`);

  if (whoami) {
    lines.push('');
    lines.push('Connected:');
    lines.push(`  email:    ${whoami.email ?? '(unknown)'}`);
    lines.push(`  team_id:  ${whoami.team_id}`);
    lines.push(`  scopes:   ${whoami.scopes.join(', ')}`);
    lines.push('');
    process.stdout.write(lines.join('\n'));
    return 0;
  }

  lines.push('');
  lines.push(`Connectivity check failed: ${pingError ?? 'unknown'}`);
  lines.push('');
  lines.push('If this persists: mysecond init --resume');
  lines.push('');
  process.stdout.write(lines.join('\n'));
  return 1;
}
