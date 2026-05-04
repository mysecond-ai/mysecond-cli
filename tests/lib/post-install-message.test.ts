// Tests for the May-2026 post-install success message redesign.
// Drives Step 13's `successBox()` output — the last thing the customer sees
// after `mysecond init`. See decision in launch-feedback-log (2026-05-01).

import { describe, expect, it } from 'vitest';

import { successBox } from '../../src/lib/copy.js';

describe('successBox: locked structure (May-2026 redesign)', () => {
  it('snapshot — happy path with full counts', () => {
    const out = successBox('Alice', 'Acme Corp', {
      skills: 91,
      agents: 6,
      workflows: 4,
    });
    expect(out).toMatchInlineSnapshot(`
      "✓ mySecond PM OS installed for Alice at Acme Corp

      Here's what's now in place:
      - pm-os plugin registered with 91 skills, 6 sub-agents, 4 workflows
      - Context sync hooks active for every Claude Code session
      - Your context files will be created in step 2 below

      Install complete. Quit and reopen Claude Code to load mySecond.

      Then run /welcome in Claude Code. It takes about 5 minutes and sets up your context files for Acme Corp (company, product, personas, competitors, goals).

      After /welcome, your full skill library — PRDs, roadmaps, research syntheses, and 80+ more — knows your team and product.

      Need help? Reply at hello@mysecond.ai or open mysecond.ai/dashboard"
    `);
  });

  it('total message stays under 20 lines (CXO budget)', () => {
    const out = successBox('Alice', 'Acme Corp', { skills: 91, agents: 6, workflows: 4 });
    expect(out.split('\n').length).toBeLessThan(20);
  });

  it('personalizes lead line with both pm name and company', () => {
    const out = successBox('Alice', 'Acme Corp', { skills: 1, agents: 1, workflows: 1 });
    expect(out).toContain('for Alice at Acme Corp');
    // Critical RED-TEAM R2 P0-A regression: not "for Alice at Alice".
    expect(out).not.toContain('for Alice at Alice');
  });

  it('mentions company name a second time in the /welcome CTA (drives ownership)', () => {
    const out = successBox('Alice', 'Acme Corp', { skills: 1, agents: 1, workflows: 1 });
    // Lead line + welcome CTA = company appears twice.
    const occurrences = out.split('Acme Corp').length - 1;
    expect(occurrences).toBe(2);
  });
});

describe('successBox: count formatting', () => {
  it('omits zero-count categories cleanly', () => {
    const out = successBox('Ron', 'mySecond', { skills: 91, agents: 0, workflows: 0 });
    expect(out).toContain('91 skills');
    expect(out).not.toContain('0 sub-agents');
    expect(out).not.toContain('0 workflows');
  });

  it('uses singular forms for count == 1', () => {
    const out = successBox('Ron', 'mySecond', { skills: 1, agents: 1, workflows: 1 });
    expect(out).toContain('1 skill,');
    expect(out).toContain('1 sub-agent,');
    expect(out).toContain('1 workflow');
    expect(out).not.toContain('1 skills');
    expect(out).not.toContain('1 sub-agents');
  });

  it('falls back to a generic phrase if all counts are zero', () => {
    const out = successBox('Ron', 'mySecond', { skills: 0, agents: 0, workflows: 0 });
    expect(out).toContain('PM skill library');
  });

  it('falls back to a generic phrase when counts are undefined', () => {
    const out = successBox('Ron', 'mySecond', undefined);
    expect(out).toContain('PM skill library');
  });
});

describe('successBox: red-team — malicious / missing names', () => {
  it('strips ANSI escape sequences from pm name', () => {
    // ESC[31m is "set foreground red". Without sanitization, this would
    // colour the rest of the customer\'s terminal output red.
    const malicious = '[31mAlice[0m';
    const out = successBox(malicious, 'Acme');
    expect(out).not.toContain('');
    expect(out).toContain('Alice');
  });

  it('strips control characters (newlines, carriage returns, tabs)', () => {
    const malicious = 'Alice\r\n\tEvil';
    const out = successBox(malicious, 'Acme');
    // Newlines/CRs would let an attacker inject extra display lines.
    expect(out).not.toContain('Alice\r');
    expect(out).not.toContain('Alice\n');
    expect(out).not.toContain('\tEvil');
    // Stripped chars collapse to a space, so the result reads "AliceEvil"
    // — sanitized but contiguous. We only assert no control chars survive.
    expect(out).toContain('Alice');
  });

  it('strips HTML angle brackets from names', () => {
    const out = successBox('<script>alert(1)</script>', 'Acme');
    expect(out).not.toContain('<script>');
    expect(out).not.toContain('</script>');
  });

  it('truncates pathologically long names', () => {
    const huge = 'A'.repeat(500);
    const out = successBox(huge, 'Acme');
    // Must not blow out the message or contain all 500 chars.
    expect(out.length).toBeLessThan(2000);
    expect(out).toContain('…');
  });

  it('falls back gracefully when company_name is missing', () => {
    const out = successBox('Alice', '');
    expect(out).toContain('for Alice at your company');
  });

  it('falls back gracefully when both names are missing', () => {
    const out = successBox('', '');
    expect(out).toContain('for you at your company');
  });

  it('handles undefined-cast inputs without crashing (defensive)', () => {
    const out = successBox(
      undefined as unknown as string,
      undefined as unknown as string
    );
    expect(out).toContain('for you at your company');
  });

  it('handles non-string inputs (defensive — server contract violation)', () => {
    const out = successBox(
      42 as unknown as string,
      { evil: true } as unknown as string
    );
    expect(out).toContain('for you at your company');
  });
});
