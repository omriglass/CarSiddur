// Cross-checks src/solver/reasons.ts against the rest of the solver source
// (docs/REFACTOR_PLAN_2026-09-11.md D9): every template/description/error key
// must actually be emitted somewhere, and every literal reason()/reasonCode
// call site must resolve to a known key — catching both dead templates and
// typos that would silently fall back to the raw code (see `reason()`).

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { reasonCodes } from '../reasons';

const SOLVER_DIR = new URL('..', import.meta.url).pathname;

function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
}

/** Non-test, non-fixture source files under src/solver, excluding reasons.ts itself. */
function listUsageFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (entry === '__tests__' || entry === '__fixtures__') continue;
    const stat = statSync(full);
    if (stat.isDirectory()) {
      out.push(...listUsageFiles(full));
    } else if (/\.tsx?$/.test(entry) && full !== join(SOLVER_DIR, 'reasons.ts')) {
      out.push(full);
    }
  }
  return out;
}

describe('src/solver/reasons.ts <-> usage sites', () => {
  const files = listUsageFiles(SOLVER_DIR);
  const contents = new Map(files.map((f) => [f, stripComments(readFileSync(f, 'utf8'))]));

  it('has at least one usage file to scan (sanity check for the scan itself)', () => {
    expect(files.length).toBeGreaterThan(5);
  });

  it('every reasons.ts key (template, rule description, param error) is referenced outside reasons.ts', () => {
    const unused: string[] = [];
    for (const code of reasonCodes) {
      const referenced = [...contents.values()].some(
        (content) => content.includes(`'${code}'`) || content.includes(`"${code}"`),
      );
      if (!referenced) unused.push(code);
    }
    expect(unused).toEqual([]);
  });

  it('every literal reason(...)/reasonCode: ... call site resolves to a known reasons.ts key', () => {
    const known = new Set(reasonCodes);
    const unknown: string[] = [];
    const CALL_PATTERN = /\breason\(\s*['"]([A-Z][A-Z0-9_]*)['"]/g;
    const FIELD_PATTERN = /\breasonCode:\s*['"]([A-Z][A-Z0-9_]*)['"]/g;

    for (const [file, content] of contents) {
      for (const pattern of [CALL_PATTERN, FIELD_PATTERN]) {
        for (const match of content.matchAll(pattern)) {
          const code = match[1];
          if (code && !known.has(code)) unknown.push(`${file}: ${code}`);
        }
      }
    }
    expect(unknown).toEqual([]);
  });
});
