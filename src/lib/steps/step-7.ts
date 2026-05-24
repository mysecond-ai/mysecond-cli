// Step 7: Write CLAUDE.md block after marker (HoD-11 three-branch + v1.4
// @import requirement). Spec §6.2 step 7 + §6.7a canonical template.
//
// Three branches: (a) CLAUDE.md missing → create with full marker block;
// (b) CLAUDE.md exists with marker → replace content between markers;
// (c) CLAUDE.md exists without marker → append marker block at end.
//
// RT-4 trailing-newline: ensure file ends with exactly one \n before append
// (prepend \n to payload if base doesn't end with newline).

import { existsSync, readFileSync } from 'node:fs';

import { atomicWriteFile } from '../atomic-write.js';
import {
  CLAUDE_MD_MARKER_END,
  CLAUDE_MD_MARKER_START,
  DEFAULT_CLAUDE_MD_IMPORTS,
  claudeMdBlock,
  spliceBetweenMarkers,
} from '../copy.js';
import { projectPaths } from '../files.js';

import type { StepFn } from './types.js';

export const step7: StepFn = async ({ ctx, shared }) => {
  const claudeMdPath = projectPaths(ctx.rootDir).claudeMdPath;
  // RED-TEAM R2 P1-C: pmName + companyName are SEPARATE fields populated by
  // step 4. Conflating them as v1.4 did wrote "for [PM] at [PM]" into the
  // customer's CLAUDE.md, persisted across every session.
  const companyName = shared.companyName ?? 'your company';
  const pmName = shared.pmName ?? 'you';
  // Init always uses the default import list — no resolved set exists yet.
  // sync.ts's regenerateMysecondBlock uses the server-provided resolved_imports
  // list after first sync.
  const block = claudeMdBlock(companyName, pmName, DEFAULT_CLAUDE_MD_IMPORTS);
  const markedBlock = `${CLAUDE_MD_MARKER_START}\n${block}\n${CLAUDE_MD_MARKER_END}`;

  if (!existsSync(claudeMdPath)) {
    // Branch (a): create with marker block.
    atomicWriteFile(claudeMdPath, `${markedBlock}\n`);
    return { step: 7, outcome: { kind: 'completed' } };
  }

  const base = readFileSync(claudeMdPath, 'utf8');

  // Branch (b): markers present — use the shared spliceBetweenMarkers helper.
  // This is the same helper sync.ts uses, guaranteeing consistent fail-closed
  // behavior across both the init and sync paths.
  const spliced = spliceBetweenMarkers(
    base,
    CLAUDE_MD_MARKER_START,
    CLAUDE_MD_MARKER_END,
    block
  );
  if (spliced !== null) {
    atomicWriteFile(claudeMdPath, spliced);
    return { step: 7, outcome: { kind: 'completed' } };
  }

  // Branch (c): no valid marker pair — append at end.
  // RT-4: ensure file ends with exactly one \n before payload.
  const trailingNewline = base.endsWith('\n') ? '' : '\n';
  const next = `${base}${trailingNewline}\n${markedBlock}\n`;
  atomicWriteFile(claudeMdPath, next);
  return { step: 7, outcome: { kind: 'completed' } };
};
