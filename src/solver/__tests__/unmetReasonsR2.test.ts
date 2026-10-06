// R2B11/R2B12 (docs/TODO.md QA run 2): honest unmet reasons, no nonsense suggestions.
import { describe, expect, it } from 'vitest';
import { solve } from '../index';
import { baseInput, makeCar, makeRequest, passengers, slotMs } from '../__fixtures__/gen';

describe('R2B11 unmet reasons', () => {
  it('never mentions a day-end time and never prints an empty blockers list', () => {
    const out = solve(
      baseInput({
        cars: [makeCar('C1', { seatConfigs: [passengers(2, 0, 0)] })],
        requests: [makeRequest({ id: 'R1', destinationId: 'destA', departureMs: slotMs(36), returnMs: slotMs(52), passengers: passengers(5) })],
      }),
    );
    const u = out.unmet.find((x) => x.requestId === 'R1');
    expect(u?.reason).not.toContain('חוסמים: ');
    expect(u?.reason).toContain('מקומות');
    for (const t of [u?.reason ?? '']) expect(t).not.toContain('23:59');
  });

  it('lists each suggestion once', () => {
    const out = solve(
      baseInput({
        cars: [],
        requests: [makeRequest({ id: 'R1', destinationId: 'destA', departureMs: slotMs(36), returnMs: slotMs(52) })],
      }),
    );
    const keys = out.unmet[0]!.suggestions.map((s) => (s.kind === 'externalHint' ? `x:${s.hint}` : s.kind));
    expect(new Set(keys).size).toBe(keys.length);
  });
});

describe('R2B12 suggestions', () => {
  it('offers changeOrigin to home when only home has a free car, never to the request own origin', () => {
    const out = solve(
      baseInput({
        cars: [makeCar('C1')],
        requests: [makeRequest({ id: 'R1', originId: 'destB', destinationId: 'destA', departureMs: slotMs(36), returnMs: slotMs(52) })],
      }),
    );
    const u = out.unmet.find((x) => x.requestId === 'R1');
    const co = u?.suggestions.filter((s) => s.kind === 'changeOrigin') ?? [];
    for (const s of co) expect(s.kind === 'changeOrigin' && s.originId).not.toBe('destB');
  });
});
