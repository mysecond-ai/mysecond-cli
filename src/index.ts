// @mysecond/cli — entry point.
//
// Dispatches to subcommand stubs. Real implementations land in:
//   - PR 4b: `mysecond sync` + `mysecond artifact-sync`
//   - PR 4c: `mysecond init`
//
// This v1.1.0 scaffold ships with stubs that exit cleanly with a "not yet implemented"
// message so the binary's shape (registry, --help, --version, unknown-subcommand) can be
// verified before the real command logic lands.

import { runInit } from './commands/init.js';
import { runSync } from './commands/sync.js';
import { runArtifactSync } from './commands/artifact-sync.js';
import { buildContext, parseGlobalFlags, type CommandContext } from './lib/context.js';
import { exitFromError, MysecondError } from './lib/errors.js';

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
    name: 'artifact-sync',
    summary: 'Push a changed artifact (skill output, doc, plan) up to mysecond.ai.',
    run: runArtifactSync,
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

  // Parse global flags from the subcommand's args (everything after the subcommand name).
  // Unknown flags fall through to positional args, which subcommands inspect themselves.
  let ctx: CommandContext;
  try {
    const flags = parseGlobalFlags(args.slice(1));
    ctx = buildContext(flags);
    return await match.run(flags.positional, ctx);
  } catch (err) {
    // parseGlobalFlags throws Error (not MysecondError) for malformed flag values —
    // treat as user-input error (exit 1) with the original message.
    if (err instanceof Error && !(err instanceof MysecondError)) {
      process.stderr.write(`mysecond: ${err.message}\n`);
      return 1;
    }
    return exitFromError(err);
  }
}

main(process.argv).then(
  (code) => process.exit(code),
  (err) => process.exit(exitFromError(err))
);
