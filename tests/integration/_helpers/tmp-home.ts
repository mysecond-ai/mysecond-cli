// tmp-home — fixture helper for integration tests that touch the filesystem.
//
// Per EDD-solo-phase-4-pmkit-cli.md §6 (PR 4c) + CTO PR 4a forward-work item #4.
// PR 4b (sync) doesn't yet need filesystem-heavy tests, but lands the helper now so
// PR 4c (init, 13 atomic steps touching ~/.npmrc + .claude/ + .env) doesn't need to
// invent its own pattern.
//
// Usage:
//   const tmp = await mkTmpHome();
//   try {
//     // process.env.HOME is now tmp.home; write files freely
//     await myCommand(['init', '--project-dir', tmp.project]);
//   } finally {
//     await tmp.cleanup();
//   }

import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export interface TmpHomeFixture {
  home: string;
  project: string;
  cleanup: () => Promise<void>;
}

export async function mkTmpHome(): Promise<TmpHomeFixture> {
  const root = await mkdtemp(join(tmpdir(), 'mysecond-test-'));
  const home = join(root, 'home');
  const project = join(root, 'project');
  await mkdir(home, { recursive: true });
  await mkdir(project, { recursive: true });

  const originalHome = process.env.HOME;
  const originalProjectDir = process.env.CLAUDE_PROJECT_DIR;
  process.env.HOME = home;
  process.env.CLAUDE_PROJECT_DIR = project;

  return {
    home,
    project,
    cleanup: async () => {
      if (originalHome === undefined) {
        delete process.env.HOME;
      } else {
        process.env.HOME = originalHome;
      }
      if (originalProjectDir === undefined) {
        delete process.env.CLAUDE_PROJECT_DIR;
      } else {
        process.env.CLAUDE_PROJECT_DIR = originalProjectDir;
      }
      await rm(root, { recursive: true, force: true });
    },
  };
}
