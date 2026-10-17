// REQ item 136 (g), docs/SOLVER.md §3.15a: an unmet request with no fallback is offered "P switches to the plan B / manage".
// Dry run only: nothing is placed or moved by the pass.
import { describe, expect, it } from 'vitest';
import { solve } from '../index';
import { baseInput, makeCar, makeDestinations, makeRequest, slotMs } from '../__fixtures__/gen';
import type { Request, SolverInput, Suggestion } from '../types';

const DROP = 'dropX';
/** Three adults each: two such requests never share a 4-seat car, so the shortage is real. */
const THREE = { adults: 3, childSeats: 0, boosters: 0 };

function input(over: Partial<SolverInput> = {}): SolverInput {
  return baseInput({
    destinations: { ...makeDestinations(), [DROP]: { id: DROP, zone: 'zoneX', distanceKm: 8, travelMinutes: 15, name: 'Junction' } },
    cars: [makeCar('C1')],
    ...over,
  });
}

/** P: 08:00-12:00 trip with a plan B (drop 16:00, pickup 18:00) in the free afternoon; priority is irrelevant. */
function planB(over: Partial<Request> = {}): Request {
  return makeRequest({
    id: 'P', memberId: 'mp', memberName: 'Noga', passengers: THREE, departureMs: slotMs(32), returnMs: slotMs(48),
    fallback: 'alternative', alternative: { dropPlaceId: DROP, arriveByMs: slotMs(64), pickupMs: slotMs(72) },
    ...over,
  });
}
/** U: no fallback, the same hours. */
function plain(over: Partial<Request> = {}): Request {
  return makeRequest({ id: 'U', memberId: 'mu', memberName: 'Dana', passengers: THREE, departureMs: slotMs(32), returnMs: slotMs(48), ...over });
}
const switchOf = (out: ReturnType<typeof solve>, id = 'U') =>
  out.unmet.find((u) => u.requestId === id)?.suggestions.find((s) => s.kind === 'planBSwitch') as Extract<Suggestion, { kind: 'planBSwitch' }> | undefined;

describe('plan-B switch (item 136 g)', () => {
  it('offers U the car if P (plan B) switches, naming P, with P plan-B numbers, and places nothing', () => {
    const out = solve(input({ requests: [planB(), plain()] }));
    const placed = out.assignments.filter((a) => a.source === 'solver');
    expect(placed).toHaveLength(1);
    const sw = switchOf(out);
    expect(sw).toMatchObject({ kind: 'planBSwitch', requestId: 'U', otherRequestId: 'P', fallback: 'alternative', carId: 'C1', reasonCode: 'SUGGEST_PLAN_B_SWITCH' });
    expect(sw!.window.start).toBe(32);
    expect(sw!.alternative).toMatchObject({ carId: 'C1', departSlot: 63 });
    expect(sw!.reason).toContain('Noga');
    expect(sw!.reason).toContain('Junction');
    expect(sw!.reason).not.toContain('P"');
  });

  it('is placed before beyond-flex shifts and the deny', () => {
    const out = solve(input({ requests: [planB(), plain()] }));
    const kinds = out.unmet.find((u) => u.requestId === 'U')!.suggestions.map((s) => s.kind);
    expect(kinds.indexOf('planBSwitch')).toBeLessThan(kinds.indexOf('deny'));
    if (kinds.includes('shiftBeyondFlex')) expect(kinds.indexOf('planBSwitch')).toBeLessThan(kinds.indexOf('shiftBeyondFlex'));
  });

  it('no suggestion when P plan B cannot be served on the remaining board', () => {
    const blocker = makeRequest({ id: 'B', memberId: 'mb', departureMs: slotMs(56), returnMs: slotMs(80) });
    const out = solve(input({ requests: [planB(), plain(), blocker] }));
    expect(switchOf(out)).toBeUndefined();
  });

  it('"manage" P: a suggestion with the manage wording and no plan-B numbers', () => {
    const out = solve(input({ requests: [planB({ fallback: 'manage', alternative: undefined }), plain()] }));
    const sw = switchOf(out);
    expect(sw).toMatchObject({ fallback: 'manage', otherRequestId: 'P', reasonCode: 'SUGGEST_MANAGE_SWITCH' });
    expect(sw!.alternative).toBeUndefined();
    expect(sw!.reason).toContain('Noga');
    expect(sw!.reason).toContain('יסתדר');
  });

  it('priority does not matter: a higher-priority P is still offered', () => {
    const out = solve(input({ requests: [planB({ manualBoost: { value: 5, reason: 'x' } }), plain()] }));
    expect(out.assignments.some((a) => a.servedRequestIds.includes('P'))).toBe(true);
    expect(switchOf(out)).toMatchObject({ otherRequestId: 'P' });
  });

  it('a request that has its own fallback is never the one offered the switch', () => {
    const out = solve(input({ requests: [planB(), planB({ id: 'P2', memberId: 'm2' })] }));
    expect(out.unmet.flatMap((u) => u.suggestions).some((s) => s.kind === 'planBSwitch')).toBe(false);
  });

  it('nothing when cars suffice (U placed anyway)', () => {
    const out = solve(input({ cars: [makeCar('C1'), makeCar('C2')], requests: [planB(), plain()] }));
    expect(out.unmet).toHaveLength(0);
  });

  it('each P is offered to one U only, in U priority order', () => {
    const out = solve(input({ requests: [planB(), plain(), plain({ id: 'U2', memberId: 'mu2' })] }));
    const offered = out.unmet.filter((u) => u.suggestions.some((s) => s.kind === 'planBSwitch'));
    expect(offered).toHaveLength(1);
  });

  it('is deterministic', () => {
    const i = input({ requests: [planB(), plain()] });
    expect(JSON.stringify(solve(i))).toBe(JSON.stringify(solve(i)));
  });

  it('does not change the main result (same assignments as the base solve)', () => {
    const withP = solve(input({ requests: [planB(), plain()] }));
    const noFallback = solve(input({ requests: [planB({ fallback: 'none', alternative: undefined }), plain()] }));
    expect(withP.assignments).toEqual(noFallback.assignments);
  });
});
