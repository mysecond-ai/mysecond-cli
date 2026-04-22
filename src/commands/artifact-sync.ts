// `mysecond artifact-sync` — PostToolUse dispatcher that pushes a changed artifact
// (skill output, doc, plan) up to mysecond.ai's /api/companion/artifacts endpoint.
//
// Stub for v1.1.0 scaffold. Real implementation lands in PR 4b per
// EDD-solo-phase-4-pmkit-cli.md §5.1.

export async function runArtifactSync(_args: readonly string[]): Promise<number> {
  process.stderr.write(
    'mysecond artifact-sync: not yet implemented in v1.1.0. ' +
      'Tracking in PR 4b — see specs/EDD-solo-phase-4-pmkit-cli.md §5.\n'
  );
  return 1;
}
