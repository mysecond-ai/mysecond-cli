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
import { CLAUDE_MD_MARKER_END, CLAUDE_MD_MARKER_START, claudeMdBlock } from '../copy.js';
import { projectPaths } from '../files.js';

import type { StepFn } from './types.js';

export const step7: StepFn = async ({ ctx, shared }) => {
  const claudeMdPath = projectPaths(ctx.rootDir).claudeMdPath;
  // RED-TEAM R2 P1-C: pmName + companyName are SEPARATE fields populated by
  // step 4. Conflating them as v1.4 did wrote "for [PM] at [PM]" into the
  // customer's CLAUDE.md, persisted across every session.
  const companyName = shared.companyName ?? 'your company';
  const pmName = shared.pmName ?? 'you';
  const block = claudeMdBlock(companyName, pmName);
  const markedBlock = `${CLAUDE_MD_MARKER_START}\n${block}\n${CLAUDE_MD_MARKER_END}`;

  if (!existsSync(claudeMdPath)) {
    // Branch (a): create with marker block.
    atomicWriteFile(claudeMdPath, `${markedBlock}\n`);
    return { step: 7, outcome: { kind: 'completed' } };
  }

  const base = readFileSync(claudeMdPath, 'utf8');
  const startIdx = base.indexOf(CLAUDE_MD_MARKER_START);
  const endIdx = base.indexOf(CLAUDE_MD_MARKER_END);

  if (startIdx !== -1 && endIdx !== -1 && endIdx > startIdx) {
    // Branch (b): replace content between markers (preserves customer's
    // surrounding CLAUDE.md edits).
    const next =
      base.slice(0, startIdx) +
      markedBlock +
      base.slice(endIdx + CLAUDE_MD_MARKER_END.length);
    atomicWriteFile(claudeMdPath, next);
    return { step: 7, outcome: { kind: 'completed' } };
  }

  // Branch (c): no marker — append at end.
  // RT-4: ensure file ends with exactly one \n before payload.
  const trailingNewline = base.endsWith('\n') ? '' : '\n';
  const next = `${base}${trailingNewline}\n${markedBlock}\n`;
  atomicWriteFile(claudeMdPath, next);
  return { step: 7, outcome: { kind: 'completed' } };
};
