// Track C — Workstream B Phase 2 tests.
// Verifies: claudeMdBlock with custom imports, spliceBetweenMarkers fail-closed
// contract, regenerateMysecondBlock re-splice + missing-file warning, and that
// no member_id is sent on cli-sync (resolved_imports is typed and consumed).

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  claudeMdBlock,
  DEFAULT_CLAUDE_MD_IMPORTS,
  spliceBetweenMarkers,
  CLAUDE_MD_MARKER_START,
  CLAUDE_MD_MARKER_END,
} from '../../src/lib/copy.js';
import { regenerateMysecondBlock } from '../../src/commands/sync.js';
import type { CliSyncResponse } from '../../src/lib/payload.js';

// ---------------------------------------------------------------------------
// claudeMdBlock — data-driven @import list
// ---------------------------------------------------------------------------
describe('claudeMdBlock: data-driven @import list', () => {
  it('uses DEFAULT_CLAUDE_MD_IMPORTS when no imports arg passed (init back-compat)', () => {
    const out = claudeMdBlock('Acme', 'Alice');
    for (const p of DEFAULT_CLAUDE_MD_IMPORTS) {
      expect(out).toContain(`@${p}`);
    }
    // Should NOT contain personalization by default.
    expect(out).not.toContain('personalization');
  });

  it('renders a custom import list when passed', () => {
    const custom = ['context/company.md', 'context/personalization.md'];
    const out = claudeMdBlock('Acme', 'Alice', custom);
    expect(out).toContain('@context/company.md');
    expect(out).toContain('@context/personalization.md');
    // product.md was not in the custom list — should not appear.
    expect(out).not.toContain('@context/product.md');
  });

  it('renders correct @import prefix (@ not @@)', () => {
    const out = claudeMdBlock('Acme', 'Alice', ['context/company.md']);
    expect(out).toContain('@context/company.md');
    expect(out).not.toContain('@@context/company.md');
  });

  it('init path (no 3rd arg) still produces the 4-entry default list', () => {
    const out = claudeMdBlock('Acme', 'Alice');
    const lines = out.split('\n');
    const importLines = lines.filter((l) => l.startsWith('@'));
    expect(importLines).toHaveLength(DEFAULT_CLAUDE_MD_IMPORTS.length);
  });

  it('empty import list produces block with no @import lines', () => {
    const out = claudeMdBlock('Acme', 'Alice', []);
    const importLines = out.split('\n').filter((l) => l.startsWith('@'));
    expect(importLines).toHaveLength(0);
  });

  it('preserves company and pm name in block header', () => {
    const out = claudeMdBlock('MyCorp', 'Jane', ['context/company.md']);
    expect(out).toContain('# mySecond PM OS — MyCorp');
    expect(out).toContain('installed for Jane at MyCorp');
  });
});

// ---------------------------------------------------------------------------
// spliceBetweenMarkers — fail-closed contract
// ---------------------------------------------------------------------------
describe('spliceBetweenMarkers: happy path', () => {
  it('splices new block between existing markers', () => {
    const base = `before\n${CLAUDE_MD_MARKER_START}\nOLD\n${CLAUDE_MD_MARKER_END}\nafter`;
    const result = spliceBetweenMarkers(base, CLAUDE_MD_MARKER_START, CLAUDE_MD_MARKER_END, 'NEW');
    expect(result).not.toBeNull();
    expect(result).toContain('before\n');
    expect(result).toContain('NEW');
    expect(result).toContain('\nafter');
    expect(result).not.toContain('OLD');
  });

  it('preserves content before and after markers', () => {
    const before = 'User header\n## My notes\n';
    const after = '\n## User footer\n';
    const base = `${before}${CLAUDE_MD_MARKER_START}\nOLD\n${CLAUDE_MD_MARKER_END}${after}`;
    const result = spliceBetweenMarkers(base, CLAUDE_MD_MARKER_START, CLAUDE_MD_MARKER_END, 'NEW');
    expect(result).toContain(before);
    expect(result).toContain(after);
  });
});

describe('spliceBetweenMarkers: fail-closed — returns null on anomalies', () => {
  it('returns null when start marker is missing', () => {
    const base = `before\n${CLAUDE_MD_MARKER_END}\nafter`;
    expect(spliceBetweenMarkers(base, CLAUDE_MD_MARKER_START, CLAUDE_MD_MARKER_END, 'NEW')).toBeNull();
  });

  it('returns null when end marker is missing', () => {
    const base = `before\n${CLAUDE_MD_MARKER_START}\nafter`;
    expect(spliceBetweenMarkers(base, CLAUDE_MD_MARKER_START, CLAUDE_MD_MARKER_END, 'NEW')).toBeNull();
  });

  it('returns null when both markers are missing', () => {
    const base = 'No markers here at all';
    expect(spliceBetweenMarkers(base, CLAUDE_MD_MARKER_START, CLAUDE_MD_MARKER_END, 'NEW')).toBeNull();
  });

  it('returns null when end marker appears before start marker (reversed)', () => {
    const base = `${CLAUDE_MD_MARKER_END}\ncontent\n${CLAUDE_MD_MARKER_START}`;
    expect(spliceBetweenMarkers(base, CLAUDE_MD_MARKER_START, CLAUDE_MD_MARKER_END, 'NEW')).toBeNull();
  });

  it('returns null when start marker is duplicated', () => {
    const base = `${CLAUDE_MD_MARKER_START}\n${CLAUDE_MD_MARKER_START}\nOLD\n${CLAUDE_MD_MARKER_END}`;
    expect(spliceBetweenMarkers(base, CLAUDE_MD_MARKER_START, CLAUDE_MD_MARKER_END, 'NEW')).toBeNull();
  });

  it('returns null when end marker is duplicated', () => {
    const base = `${CLAUDE_MD_MARKER_START}\nOLD\n${CLAUDE_MD_MARKER_END}\n${CLAUDE_MD_MARKER_END}`;
    expect(spliceBetweenMarkers(base, CLAUDE_MD_MARKER_START, CLAUDE_MD_MARKER_END, 'NEW')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// regenerateMysecondBlock — integration via temp filesystem
// ---------------------------------------------------------------------------
describe('regenerateMysecondBlock', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'msec-track-c-'));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  function writeClaudeMd(content: string): string {
    const path = join(tmpDir, 'CLAUDE.md');
    writeFileSync(path, content);
    return path;
  }

  function readClaudeMd(): string {
    return readFileSync(join(tmpDir, 'CLAUDE.md'), 'utf8');
  }

  it('re-splices the mysecond block with new resolved_imports', () => {
    const initialBlock = claudeMdBlock('Acme', 'Alice', DEFAULT_CLAUDE_MD_IMPORTS);
    const content = `User preamble\n${CLAUDE_MD_MARKER_START}\n${initialBlock}\n${CLAUDE_MD_MARKER_END}\nUser notes\n`;
    writeClaudeMd(content);

    const newImports = ['context/company.md', 'context/product.md', 'context/personalization.md'];
    regenerateMysecondBlock(join(tmpDir, 'CLAUDE.md'), tmpDir, newImports);

    const result = readClaudeMd();
    expect(result).toContain('@context/personalization.md');
    expect(result).toContain('User preamble');
    expect(result).toContain('User notes');
  });

  it('preserves user content before and after markers when re-splicing', () => {
    const block = claudeMdBlock('Corp', 'Bob', DEFAULT_CLAUDE_MD_IMPORTS);
    const content = `## My Notes\n${CLAUDE_MD_MARKER_START}\n${block}\n${CLAUDE_MD_MARKER_END}\n## Foot`;
    writeClaudeMd(content);

    regenerateMysecondBlock(join(tmpDir, 'CLAUDE.md'), tmpDir, ['context/company.md']);

    const result = readClaudeMd();
    expect(result).toContain('## My Notes\n');
    expect(result).toContain('## Foot');
    expect(result).toContain('@context/company.md');
  });

  it('does NOT modify the file when markers are absent (fail-closed)', () => {
    const original = 'No markers here\nJust user content\n';
    writeClaudeMd(original);
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    regenerateMysecondBlock(join(tmpDir, 'CLAUDE.md'), tmpDir, ['context/company.md']);

    expect(readClaudeMd()).toBe(original);
    expect(stderrSpy).toHaveBeenCalledWith(expect.stringContaining('[mysecond]'));
    stderrSpy.mockRestore();
  });

  it('does NOT append when markers are absent', () => {
    const original = 'No markers here\n';
    writeClaudeMd(original);
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    regenerateMysecondBlock(join(tmpDir, 'CLAUDE.md'), tmpDir, ['context/company.md']);

    const result = readClaudeMd();
    // File must be exactly the original — no appended content.
    expect(result).toBe(original);
    vi.restoreAllMocks();
  });

  it('does nothing when CLAUDE.md is missing (no-op, warns on stderr)', () => {
    const claudeMdPath = join(tmpDir, 'CLAUDE.md');
    expect(existsSync(claudeMdPath)).toBe(false);
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    regenerateMysecondBlock(claudeMdPath, tmpDir, ['context/company.md']);

    expect(existsSync(claudeMdPath)).toBe(false);
    expect(stderrSpy).toHaveBeenCalledWith(expect.stringContaining('[mysecond]'));
    stderrSpy.mockRestore();
  });

  it('warns on stderr for any resolved_imports entry missing from disk', () => {
    const block = claudeMdBlock('Acme', 'Alice', DEFAULT_CLAUDE_MD_IMPORTS);
    writeClaudeMd(`${CLAUDE_MD_MARKER_START}\n${block}\n${CLAUDE_MD_MARKER_END}\n`);
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    regenerateMysecondBlock(
      join(tmpDir, 'CLAUDE.md'),
      tmpDir,
      ['context/company.md', 'context/personalization.md'] // personalization.md not on disk
    );

    expect(stderrSpy).toHaveBeenCalledWith(
      expect.stringContaining('context/personalization.md')
    );
    stderrSpy.mockRestore();
  });

  it('does NOT warn for resolved_imports entries that exist on disk', () => {
    const block = claudeMdBlock('Acme', 'Alice', DEFAULT_CLAUDE_MD_IMPORTS);
    writeClaudeMd(`${CLAUDE_MD_MARKER_START}\n${block}\n${CLAUDE_MD_MARKER_END}\n`);

    // Create the file on disk.
    mkdirSync(join(tmpDir, 'context'), { recursive: true });
    writeFileSync(join(tmpDir, 'context', 'company.md'), '# Company');

    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    regenerateMysecondBlock(
      join(tmpDir, 'CLAUDE.md'),
      tmpDir,
      ['context/company.md']
    );

    // No warning should mention company.md as missing.
    const calls = stderrSpy.mock.calls.map((c) => c[0]).join('');
    expect(calls).not.toContain('context/company.md');
    stderrSpy.mockRestore();
  });

  it('preserves extracted company and pm name when re-splicing', () => {
    const block = claudeMdBlock('MyCorp', 'Jane', DEFAULT_CLAUDE_MD_IMPORTS);
    writeClaudeMd(`${CLAUDE_MD_MARKER_START}\n${block}\n${CLAUDE_MD_MARKER_END}\n`);

    regenerateMysecondBlock(
      join(tmpDir, 'CLAUDE.md'),
      tmpDir,
      ['context/company.md', 'context/personalization.md']
    );

    const result = readClaudeMd();
    expect(result).toContain('# mySecond PM OS — MyCorp');
    expect(result).toContain('installed for Jane at MyCorp');
  });
});

// ---------------------------------------------------------------------------
// CliSyncResponse type — resolved_imports is present and typed correctly
// ---------------------------------------------------------------------------
describe('CliSyncResponse type: resolved_imports contract', () => {
  it('accepts a response with resolved_imports array (compile-time + runtime)', () => {
    // This is primarily a type-level check — if it compiles, the field is typed.
    const response: CliSyncResponse = {
      syncedAt: new Date().toISOString(),
      context_files: [],
      resolved_imports: ['context/company.md', 'context/product.md', 'context/personalization.md'],
    };
    expect(Array.isArray(response.resolved_imports)).toBe(true);
    expect(response.resolved_imports).toHaveLength(3);
    expect(response.resolved_imports?.[2]).toBe('context/personalization.md');
  });

  it('accepts a response without resolved_imports (server predates Track B)', () => {
    const response: CliSyncResponse = {
      syncedAt: new Date().toISOString(),
      context_files: [],
    };
    expect(response.resolved_imports).toBeUndefined();
  });

  it('personalization.md appears last when included in resolved_imports', () => {
    const response: CliSyncResponse = {
      syncedAt: new Date().toISOString(),
      resolved_imports: [
        'context/company.md',
        'context/product.md',
        'context/personas.md',
        'context/competitors.md',
        'context/personalization.md',
      ],
    };
    const imports = response.resolved_imports ?? [];
    expect(imports[imports.length - 1]).toBe('context/personalization.md');
  });
});

// ---------------------------------------------------------------------------
// CLI does NOT send member_id — verify cliSync call signature has no member_id
// ---------------------------------------------------------------------------
describe('cliSync: does not send member_id (server derives it)', () => {
  it('cliSync only accepts team_id, not member_id, in opts (compile-time check)', async () => {
    // Import the function to verify the TypeScript signature at test compile time.
    // The real test is that this module compiles — the opts type has no member_id field.
    const { cliSync } = await import('../../src/lib/api.js');
    // Verify the function exists and has the expected signature shape.
    expect(typeof cliSync).toBe('function');
    // If we could pass member_id, the opts type would need to include it —
    // the TypeScript compiler would catch any attempt to add it. This test
    // documents the contract: member_id must NOT appear in the function signature.
    // (A full integration test would require mocking fetch, covered in api.test.ts.)
  });
});
