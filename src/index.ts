// @mysecond/cli — entry point. Parses global flags, builds CommandContext, dispatches.

import { runInit } from './commands/init.js';
import { runPushOnly, runSync } from './commands/sync.js';
import { runArtifactSync } from './commands/artifact-sync.js';
import { runEmitEvent } from './commands/emit-event.js';
import { runPluginRefresh } from './commands/plugin-refresh.js';
import { runWhereami } from './commands/whereami.js';
import { runCredentials } from './commands/credentials.js';
import { runDoctor } from './commands/doctor.js';
import { setSilentMode } from './lib/silent-status.js';
import { buildContext, parseGlobalFlags, type CommandContext } from './lib/context.js';
import { exitFromError } from './lib/errors.js';

declare const __VERSION__: string;

interface Subcommand {
  name: string;
  summary: string;
  run: (args: string[], ctx: CommandContext) => Promise<number>;
}

const SUBCOMMANDS: readonly Subcommand[] = [
  {
    name: 'init',
    summary: 'Install your mySecond PM OS into the current Claude Code workspace.',
    run: runInit,
  },
  {
    name: 'sync',
    summary: 'Sync the latest context, skills, and agents from mysecond.ai into the workspace.',
    run: runSync,
  },
  {
    // The realtime turn-end push hook (Stop/SubagentStop) targets this
    // SUBCOMMAND, not `sync --push-only`, on purpose: an OLD CLI that predates
    // it exits non-zero on an unknown subcommand (whereas `sync` silently
    // swallows an unknown flag and runs a full pull), so the hook's
    // `|| npx @latest` fallback reliably fires for every install cohort.
    name: 'push',
    summary: 'Push changed context/work files up to mysecond.ai (no pull). Used by the realtime hook.',
    run: (_args, ctx) => runPushOnly(ctx),
  },
  {
    name: 'artifact-sync',
    summary: 'Push a changed artifact (skill output, doc, plan) up to mysecond.ai.',
    run: runArtifactSync,
  },
  {
    name: 'emit-event',
    summary: 'Emit a Claude Code usage event (skill/workflow/subagent run) for adoption tracking. Used by the tracking hook.',
    run: runEmitEvent,
  },
  {
    name: 'plugin-refresh',
    summary: 'Re-install the latest PM OS plugin — refreshes hooks/skills for an existing install.',
    run: runPluginRefresh,
  },
  {
    name: 'whereami',
    summary: 'Print where this project\'s COMPANION_API_KEY is loaded from + the precedence chain.',
    run: runWhereami,
  },
  {
    name: 'credentials',
    summary: 'Print this project\'s resolved credential (masked; --plaintext for hooks to source).',
    run: runCredentials,
  },
  {
    name: 'doctor',
    summary: 'Check install state + token health. Reports next-step command on any failure.',
    run: runDoctor,
  },
];

function printHelp(): void {
  const lines = [
    `mysecond v${__VERSION__} — mySecond PM Operating System CLI`,
    '',
    'Usage:',
    '  mysecond <subcommand> [options]',
    '',
    'Subcommands:',
    ...SUBCOMMANDS.map((cmd) => `  ${cmd.name.padEnd(15)}${cmd.summary}`),
    '',
    'Options:',
    '  --version, -v          Print version and exit',
    '  --help, -h             Print this help and exit',
    '  --silent               Suppress non-essential output (used by hooks)',
    '  --dry-run              Show what would happen, make no changes',
    '  --api-key <key>        Override COMPANION_API_KEY env',
    '  --project-dir <path>   Override $CLAUDE_PROJECT_DIR / cwd',
    '  --strategy <mode>      Conflict resolution: prompt | cloud-wins | local-wins | skip',
    '  --force-update         Bypass the 24-hour npm-update timebox in sync',
    '  --push-all             Push all local context/ + work output files up to mySecond (`mysecond sync` only). Repairs an empty workspace.',
    '  --push-only            Push only CHANGED context/work files, skip the pull (`mysecond sync` only). Used by the per-turn realtime hook.',
    '  --fix                  Resolve init conflicts interactively (`mysecond init` only)',
    '  --auth-only            Mint device code, persist state, exit (`mysecond init` only). Pairs with --resume.',
    '  --resume               Resume install from persisted auth state OR re-run device-code OAuth (`mysecond init` only)',
    '',
    'Docs: https://mysecond.ai',
  ];
  process.stdout.write(lines.join('\n') + '\n');
}

export async function main(argv: readonly string[]): Promise<number> {
  const args = argv.slice(2);
  const first = args[0];

  if (first === '--version' || first === '-v') {
    process.stdout.write(__VERSION__ + '\n');
    return 0;
  }

  if (first === undefined || first === '--help' || first === '-h') {
    printHelp();
    return 0;
  }

  const match = SUBCOMMANDS.find((cmd) => cmd.name === first);
  if (!match) {
    process.stderr.write(
      `mysecond: unknown subcommand '${first}'.\n` +
        `Run 'mysecond --help' to see available subcommands.\n`
    );
    return 1;
  }

  try {
    const flags = parseGlobalFlags(args.slice(1));
    // Workstream B Day 4: enable structured JSON status protocol when --silent.
    // Emissions before this call are no-ops, so order matters — set first.
    setSilentMode(flags.silent);
    const ctx = buildContext(flags);
    return await match.run(flags.positional, ctx);
  } catch (err) {
    return exitFromError(err);
  }
}

main(process.argv).then(
  (code) => process.exit(code),
  (err) => process.exit(exitFromError(err))
);
