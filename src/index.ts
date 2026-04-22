// @mysecond/cli — entry point.
//
// Dispatches to subcommand stubs. Real implementations land in:
//   - PR 4b: `mysecond sync` + `mysecond artifact-sync`
//   - PR 4c: `mysecond init`
//
// This v1.1.0 scaffold ships with stubs that exit cleanly with a "not yet implemented"
// message so the binary's shape (registry, --help, --version, unknown-subcommand) can be
// verified before the real command logic lands.

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { runInit } from './commands/init.js';
import { runSync } from './commands/sync.js';
import { runArtifactSync } from './commands/artifact-sync.js';

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

function readVersion(): string {
  const __filename = fileURLToPath(import.meta.url);
  const __dirname = dirname(__filename);
  // The bundle lives at dist/mysecond.mjs and package.json is one level up.
  // When running from source (vitest), import.meta.url points to src/, so package.json
  // is also one level up. Both layouts resolve to ../package.json.
  const pkgPath = resolve(__dirname, '..', 'package.json');
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as { version: string };
  return pkg.version;
}

function printHelp(version: string): void {
  const lines = [
    `mysecond v${version} — mySecond PM Operating System CLI`,
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
    process.stdout.write(readVersion() + '\n');
    return 0;
  }

  if (first === undefined || first === '--help' || first === '-h') {
    printHelp(readVersion());
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

const exitCode = await main(process.argv);
process.exit(exitCode);
