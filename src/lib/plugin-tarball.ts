// Plugin tarball: signed-URL fetch, SHA-256 verify, cross-platform extract.
// Spec §6.2 step 9 sub-steps (a)-(d). Honors HTTPS_PROXY/HTTP_PROXY/NO_PROXY env
// (Decision 0-C guardrail #5) — Node 18+ undici respects these by default.

import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream, mkdirSync, unlinkSync } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { extract as tarExtract } from 'tar';

import type { CommandContext } from './context.js';
import { MysecondError } from './errors.js';

export interface PluginTarballMeta {
  signed_url: string;
  sha256: string;
  version: string;
  expires_at: string;
}

// Download the tarball from a signed URL into `destFile`, verifying the SHA-256
// against the server-supplied checksum. Returns true on first-attempt success;
// caller decides retry policy.
export async function downloadAndVerifyTarball(
  meta: PluginTarballMeta,
  destFile: string
): Promise<void> {
  // Stream to disk so we never hold a multi-MB plugin in RAM.
  const response = await fetch(meta.signed_url, { method: 'GET' });
  if (!response.ok) {
    // RED-TEAM R2 P0-B: actionable copy for CDN-side rejections (NOT our
    // server). 401/403 from a signed URL = either the URL expired mid-fetch
    // (slow connection, signed-URL TTL is 5 min — see §0 Decision 0-C) OR a
    // corporate firewall is blocking the object-storage CDN hostname. Both
    // need different customer guidance than "check internet." Preserve
    // subCode='network' so step 9's last-known-good fallback still fires.
    if (response.status === 401 || response.status === 403) {
      throw new MysecondError(
        6,
        `Couldn't download your PM OS plugin (HTTP ${response.status} from CDN). Most likely: the signed URL expired during download (slow connection) OR your network blocks Supabase Storage / S3. Try: re-run \`mysecond init\`. If on corporate WiFi, ask IT to allowlist *.mysecond.ai and your Supabase Storage region. Cached version available? Falling back automatically.`,
        { subCode: 'network' }
      );
    }
    throw MysecondError.networkUnreachable(
      `signed-URL fetch returned HTTP ${response.status}`
    );
  }
  if (response.body === null) {
    throw MysecondError.networkUnreachable('signed-URL response had no body');
  }

  // Pipe to disk + compute SHA in same pass.
  const hash = createHash('sha256');
  const out = createWriteStream(destFile);
  const reader = response.body.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      hash.update(value);
      // Backpressure: write returns false when buffer full; await drain.
      if (!out.write(value)) {
        await new Promise<void>((resolve) => out.once('drain', () => resolve()));
      }
    }
  } finally {
    out.end();
    await new Promise<void>((resolve, reject) => {
      out.once('finish', () => resolve());
      out.once('error', (err) => reject(err));
    });
  }

  const actual = hash.digest('hex');
  if (actual !== meta.sha256) {
    // Caller will retry once on first mismatch (§6.2 step 9 sub-step (c)).
    try {
      unlinkSync(destFile);
    } catch {
      // best-effort cleanup
    }
    throw new MysecondError(
      6,
      `Tarball SHA-256 mismatch: expected ${meta.sha256}, got ${actual}. The download may be corrupted.`
    );
  }
}

// Extract a tarball into `destDir`. Uses the `tar` npm package — cross-platform
// per Decision 0-C guardrail #4 (no shell `tar`).
export async function extractTarball(
  tarballPath: string,
  destDir: string
): Promise<void> {
  mkdirSync(destDir, { recursive: true });
  // tar.extract accepts a stream OR a file path. Streaming the file gives
  // better memory characteristics and matches the download pattern.
  await pipeline(
    createReadStream(tarballPath),
    tarExtract({
      cwd: destDir,
      strict: true,
      // strip = 0 means preserve archive's internal directory structure.
      // Tarball contents per §15.2: the regen worker writes the plugin tree
      // at the tarball root (no top-level prefix dir).
      strip: 0,
    })
  );
}

// Convenience: download + verify + extract in one call. Caller wraps in retry.
export async function fetchAndExtractPlugin(
  ctx: CommandContext,
  meta: PluginTarballMeta,
  tmpTarballPath: string,
  destDir: string
): Promise<void> {
  // ctx threaded through for future telemetry hooks (PostHog event for proxy
  // env detected, etc.); not strictly needed for fetch itself since undici
  // honors HTTPS_PROXY automatically.
  void ctx;
  await downloadAndVerifyTarball(meta, tmpTarballPath);
  await extractTarball(tmpTarballPath, destDir);
}
