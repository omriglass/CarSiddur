// Asserts the purity contract (CLAUDE.md hard rule 5, docs/SOLVER.md intro):
// nothing under src/solver imports React, the DOM, Supabase, or anything
// outside src/solver (plus the tiny pure deps zod/fast-check in tests).

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const SOLVER_DIR = new URL('..', import.meta.url).pathname;

const FORBIDDEN_PATTERNS = [
  /from ['"]react/,
  /from ['"]react-dom/,
  /from ['"]@supabase/,
  /from ['"]@\/integrations/,
  /from ['"]@\/i18n/,
  /from ['"]@\/features/,
  /from ['"]@\//, // any alias import reaching outside src/solver
];

/** Strips comments so doc-comments that merely *mention* a forbidden API don't trip the scan. */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
}

function listSourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) {
      out.push(...listSourceFiles(full));
    } else if (/\.tsx?$/.test(entry) && !entry.endsWith('.test.ts') && !entry.endsWith('.test.tsx')) {
      out.push(full);
    }
  }
  return out;
}

describe('src/solver purity', () => {
  const files = listSourceFiles(SOLVER_DIR);

  it('has at least the expected number of non-test source files', () => {
    expect(files.length).toBeGreaterThan(10);
  });

  it('never imports React, the DOM, Supabase, i18n, or features from outside src/solver', () => {
    const offenders: string[] = [];
    for (const file of files) {
      const content = stripComments(readFileSync(file, 'utf8'));
      for (const pattern of FORBIDDEN_PATTERNS) {
        if (pattern.test(content)) offenders.push(`${file}: matched ${pattern}`);
      }
      // DOM-specific calls, not the (very common in this domain) `window: Window` time-range type.
      if (/\bdocument\.(getElementById|createElement|querySelector)/.test(content)) {
        offenders.push(`${file}: touches document`);
      }
      if (/\bwindow\.(addEventListener|location|localStorage|fetch)\b/.test(content)) {
        offenders.push(`${file}: touches the DOM window global`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('never calls Date.now(), new Date() without arguments, or Math.random()', () => {
    const offenders: string[] = [];
    for (const file of files) {
      if (file.endsWith(join('__fixtures__', 'gen.ts'))) continue; // test-support only, not part of the solve() pipeline
      const content = stripComments(readFileSync(file, 'utf8'));
      if (/Date\.now\(\)/.test(content)) offenders.push(`${file}: Date.now()`);
      if (/new Date\(\s*\)/.test(content)) offenders.push(`${file}: new Date()`);
      if (/Math\.random\(\)/.test(content)) offenders.push(`${file}: Math.random()`);
    }
    expect(offenders).toEqual([]);
  });

  it('only imports from itself and package-level deps (no relative escapes above src/solver)', () => {
    const offenders: string[] = [];
    for (const file of files) {
      const content = stripComments(readFileSync(file, 'utf8'));
      const matches = content.matchAll(/from ['"](\.\.[^'"]*)['"]/g);
      for (const m of matches) {
        const spec = m[1] ?? '';
        // any relative import must stay within src/solver (fixtures/tests may go up one level at most, source never does)
        if (spec.startsWith('../..')) offenders.push(`${file}: escapes src/solver via ${spec}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
