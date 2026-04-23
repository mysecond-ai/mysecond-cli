// Step 4: Poll /api/companion/install-ready/{slug} every 3s up to 60s.
// Spec §6.6 + §6.6a (mid-poll copy transitions). 7 status handlers + ready:true.
//
// On `access_revoked`: purge last-known-good cache (CRO mitigation per §6.2.B)
// before exit 1.

import { installReady } from '../api.js';
import { STATUS_COPY, midPollCopy } from '../copy.js';
import { MysecondError } from '../errors.js';
import { purgeLastKnownGood } from '../last-known-good.js';
import { validateSlug } from '../mysecond-paths.js';

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
  const rawSlug = process.env.MYSECOND_CUSTOMER_SLUG ?? state.customerSlug;
  if (rawSlug === null || rawSlug === undefined || rawSlug === '') {
    throw new MysecondError(
      1,
      'Missing customer slug. The mysecond.ai/activate/complete page should have provided MYSECOND_CUSTOMER_SLUG. Re-paste the install command or contact support@mysecond.ai.'
    );
  }
  // RED-TEAM P0-2: validate slug format BEFORE any filesystem path uses it.
  // A server-controlled slug like `../../etc` would otherwise traverse out
  // of ~/.mysecond/marketplaces/ in step 9.
  let slug: string;
  try {
    slug = validateSlug(rawSlug);
  } catch (err) {
    throw new MysecondError(1, err instanceof Error ? err.message : String(err));
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
    // RED-TEAM R2 P0-A: thread pm_name + company_name SEPARATELY. Server
    // contract: both fields independently optional. Fallback chain:
    //   pmName      <- response.pm_name      || response.customer_name (v1.4 alias)
    //   companyName <- response.company_name || response.customer_name (v1.4 alias)
    // If neither is set, downstream copy uses generic "you" / "your company".
    const responseAny = response as { pm_name?: string; company_name?: string; customer_name?: string };
    if (responseAny.pm_name !== undefined && responseAny.pm_name !== '') {
      shared.pmName = responseAny.pm_name;
    } else if (responseAny.customer_name !== undefined && responseAny.customer_name !== '') {
      shared.pmName = responseAny.customer_name;
    }
    if (responseAny.company_name !== undefined && responseAny.company_name !== '') {
      shared.companyName = responseAny.company_name;
    } else if (responseAny.customer_name !== undefined && responseAny.customer_name !== '') {
      // Last-resort: if server only sent customer_name (v1.4 contract),
      // we don't have a real company name. Use customer_name as a poor-man's
      // fallback rather than printing "your company" — at least the customer
      // sees their own name twice instead of generic copy. UX call: this is
      // documented in the spec as a known v1.4-back-compat behavior.
      shared.companyName = responseAny.customer_name;
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
