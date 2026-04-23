// Step 10: Post-install plugin-load probe (Layer 1 only — Layers 2 + 3 ship in
// PR 4d). If the filesystem probe finds the plugin manifest at the expected
// cache path, step 9's install was successful and Claude Code will load it on
// next session start. If not, soft-warn and continue (don't block) — PR 4d
// will add the sentinel probe + admin-restricted exit 5 path.

import { MysecondError } from '../errors.js';
import { probeLayerOne } from '../plugin-load-detect.js';

import type { StepFn } from './types.js';

export const step10: StepFn = async ({ ctx, shared, state }) => {
  const slug = shared.customerSlug ?? state.customerSlug;
  const version = shared.pluginVersion;
  if (slug === null || slug === undefined) {
    throw new MysecondError(1, 'Step 10: missing customer slug.');
  }

  const probe = probeLayerOne(slug, version ?? null);
  if (!probe.found) {
    // Soft warn — PR 4d adds the sentinel + exit 5. For PR 4c we let the
    // success box still render; if the customer hits "/skills" and Claude
    // doesn't recognize it, that's the failure mode PR 4d's sentinel catches.
    if (!ctx.silent) {
      process.stderr.write(
        'mysecond: plugin-load probe could not find the installed plugin in cache. PR 4d sentinel probe will surface admin-restriction or version skew. Proceeding…\n'
      );
    }
  }
  return { step: 10, outcome: { kind: 'completed' } };
};
