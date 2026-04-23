// Step 4: Poll /api/companion/install-ready/{slug} every 3s up to 60s.
// Spec §6.6 + §6.6a (mid-poll copy transitions). 7 status handlers + ready:true.
//
// On `access_revoked`: purge last-known-good cache (CRO mitigation per §6.2.B)
// before exit 1.

import { installReady } from '../api.js';
import { STATUS_COPY, midPollCopy } from '../copy.js';
import { MysecondError } from '../errors.js';
import { purgeLastKnownGood } from '../last-known-good.js';

import type { StepFn } from './types.js';

const POLL_INTERVAL_MS = 3_000;
const POLL_CEILING_MS = 60_000;

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

export const step4: StepFn = async ({ ctx, state, shared }) => {
  // Customer slug is needed BEFORE step 4 — it comes from a separate boot
  // signal. For Solo flow, it's typically passed via env (CUSTOMER_SLUG) or
  // from a prior `mysecond setup`. PR 4c bootstrap: read from
  // process.env.MYSECOND_CUSTOMER_SLUG, fall back to an early /api lookup.
  // For v1 we require the env var (provisioned by activate/complete page).
  const slug = process.env.MYSECOND_CUSTOMER_SLUG ?? state.customerSlug;
  if (slug === null || slug === undefined || slug === '') {
    throw new MysecondError(
      1,
      'Missing customer slug. The mysecond.ai/activate/complete page should have provided MYSECOND_CUSTOMER_SLUG. Re-paste the install command or contact support@mysecond.ai.'
    );
  }

  const start = Date.now();
  let lastStatus: string | null = null;

  while (Date.now() - start < POLL_CEILING_MS) {
    const response = await installReady(ctx, slug);

    // Capture identity once on any response (ready or pending).
    if ('customer_id' in response && response.customer_id !== undefined) {
      shared.customerId = response.customer_id;
      state.customerId = response.customer_id;
    }
    if ('customer_name' in response && response.customer_name !== undefined) {
      shared.customerName = response.customer_name;
    }
    if ('workspace_scope' in response && response.workspace_scope !== undefined) {
      shared.workspaceScope = response.workspace_scope;
      state.workspaceScope = response.workspace_scope;
    }
    if ('customer_slug' in response && response.customer_slug !== undefined) {
      shared.customerSlug = response.customer_slug;
      state.customerSlug = response.customer_slug;
    } else {
      shared.customerSlug = slug;
      state.customerSlug = slug;
    }

    if (response.ready) {
      shared.pluginVersion = response.version;
      return {
        step: 4,
        outcome: { kind: 'completed' },
        ...(ctx.silent ? {} : { message: 'Your PM OS is ready to install.' }),
      };
    }

    // Pending — branch on status.
    switch (response.status) {
      case 'regen_failed':
        throw new MysecondError(
          6,
          STATUS_COPY.regen_failed(response.customer_id ?? 'unknown')
        );

      case 'access_revoked':
        // CRO mitigation: purge last-known-good before exit so a revoked
        // customer can't keep running an old cached plugin offline.
        purgeLastKnownGood(slug);
        throw new MysecondError(
          1,
          STATUS_COPY.access_revoked(response.customer_id ?? 'unknown')
        );

      case 'schema_drift':
        throw new MysecondError(3, STATUS_COPY.schema_drift, { subCode: 'schema_drift' });

      case 'provisioning':
      case 'regen_queued':
      case 'regen_in_progress':
      case 're_provisioning': {
        const elapsed = Date.now() - start;
        const copy = midPollCopy(elapsed, response.status);
        if (!ctx.silent && copy !== lastStatus) {
          process.stdout.write(`${copy}\n`);
          lastStatus = copy;
        }
        await sleep(POLL_INTERVAL_MS);
        break;
      }
    }
  }

  // CXO-12 fallback (regen-gap email NOT wired — don't promise email infra).
  throw new MysecondError(4, STATUS_COPY.poll_timeout);
};
