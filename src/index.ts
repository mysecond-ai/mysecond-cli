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

declare const __VERSION__: string;

interface Subcommand {
  name: string;
  summary: string;
  run: (args: string[]) => Promise<number>;
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
    '  --version, -v    Print version and exit',
    '  --help, -h       Print this help and exit',
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

  return match.run(args.slice(1));
}

main(process.argv).then(
  (code) => process.exit(code),
  (err) => {
    process.stderr.write(`mysecond: unexpected error: ${err && err.stack ? err.stack : err}\n`);
    process.exit(1);
  }
);
