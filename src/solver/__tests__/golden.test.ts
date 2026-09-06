// Golden fixture comparisons (docs/SOLVER.md §7.3): <name>.input.json +
// <name>.expected.json, compared with toEqual (not snapshots) so a diff is
// reviewed, never blindly regenerated.

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { solve } from '../index';
import type { SolverInput, SolverOutput } from '../types';

function loadFixture(name: string): { input: SolverInput; expected: SolverOutput } {
  const dir = new URL('../__fixtures__/', import.meta.url);
  const input = JSON.parse(readFileSync(new URL(`${name}.input.json`, dir), 'utf8')) as SolverInput;
  const expected = JSON.parse(readFileSync(new URL(`${name}.expected.json`, dir), 'utf8')) as SolverOutput;
  return { input, expected };
}

describe('golden fixture: basic-4x8 (docs/SOLVER.md §8 worked example)', () => {
  const { input, expected } = loadFixture('basic-4x8');

  it('reproduces the full worked example output exactly', () => {
    const output = solve(input);
    expect(output).toEqual(expected);
  });

  it('places every request on the documented car at the documented time', () => {
    const output = solve(input);
    const byRequest = new Map(output.assignments.map((a) => [a.servedRequestIds[0], a]));

    expect(byRequest.get('R1')?.carId).toBe('C1');
    expect(byRequest.get('R1')?.window).toEqual({ start: 128, end: 144 }); // 08:00-12:00
    expect(byRequest.get('R1')?.reasonCode).toBe('PLACED_PREFERRED');

    expect(byRequest.get('R4')?.carId).toBe('C1');
    expect(byRequest.get('R4')?.window).toEqual({ start: 148, end: 158 }); // 13:00-15:30

    // R8 relocated 30 min earlier to free C2 for R5 (the improvement pass).
    expect(byRequest.get('R8')?.carId).toBe('C2');
    expect(byRequest.get('R8')?.window).toEqual({ start: 144, end: 152 }); // 12:00-14:00
    expect(byRequest.get('R8')?.shift).toEqual({ departureMin: -30, returnMin: -30 });

    expect(byRequest.get('R5')?.carId).toBe('C2');
    expect(byRequest.get('R5')?.window).toEqual({ start: 154, end: 160 }); // 14:30-16:00
    expect(byRequest.get('R5')?.shift).toEqual({ departureMin: 60, returnMin: 60 });

    // R3/R7 relay pair on C3, paired with no shift, idle at BIN in between.
    const r3 = byRequest.get('R3');
    const r7 = byRequest.get('R7');
    expect(r3?.carId).toBe('C3');
    expect(r7?.carId).toBe('C3');
    expect(r3?.window).toEqual({ start: 132, end: 135 }); // 09:00-09:45
    expect(r7?.window).toEqual({ start: 141, end: 144 }); // 11:15-12:00
    expect(r3?.pairedRideId).toBe(r7?.rideId);
    expect(r7?.pairedRideId).toBe(r3?.rideId);
    expect(r3?.reasonCode).toBe('PLACED_RELAY_PAIR');

    expect(byRequest.get('R6')?.carId).toBe('C4');
    expect(byRequest.get('R6')?.window).toEqual({ start: 132, end: 166 }); // 09:00-17:30

    expect(output.carsAway).toEqual([{ carId: 'C3', locationId: 'BIN', window: { start: 135, end: 141 } }]);
    expect(output.stats.served).toBe(7);
  });

  it('leaves Yossi (R2) unmet with suggestions in the documented order: merge, externalHint, deny', () => {
    const output = solve(input);
    expect(output.unmet).toHaveLength(1);
    const unmet = output.unmet[0];
    expect(unmet?.requestId).toBe('R2');
    expect(unmet?.suggestions.map((s) => s.kind)).toEqual(['merge', 'externalHint', 'deny']);

    const merge = unmet?.suggestions[0];
    expect(merge?.kind).toBe('merge');
    if (merge?.kind === 'merge') {
      expect(merge.hostRideId).toBe('ride:R6');
      expect(merge.detourMinutes).toBe(0);
      expect(merge.proposedDriverRequestId).toBe('R6');
    }

    const hint = unmet?.suggestions[1];
    expect(hint?.kind).toBe('externalHint');
    if (hint?.kind === 'externalHint') expect(hint.hint).toBe('publicTransport');

    expect(unmet?.suggestions[2]?.kind).toBe('deny');
  });
});

describe('golden fixture: fixed-rides-only', () => {
  const { input, expected } = loadFixture('fixed-rides-only');

  it('a pinned ride with no open requests passes through unchanged', () => {
    const output = solve(input);
    expect(output).toEqual(expected);
    expect(output.assignments).toHaveLength(1);
    expect(output.assignments[0]?.source).toBe('fixed');
    expect(output.unmet).toHaveLength(0);
  });
});

describe('golden fixture: all-unmet (zero cars in the department)', () => {
  const { input, expected } = loadFixture('all-unmet');

  it('every request is denied, none crashes the solver', () => {
    const output = solve(input);
    expect(output).toEqual(expected);
    expect(output.assignments).toHaveLength(0);
    expect(output.unmet).toHaveLength(2);
    for (const u of output.unmet) {
      expect(u.suggestions.at(-1)?.kind).toBe('deny');
    }
  });
});
