// One-way relay-pair-vs-chauffeur golden cases, shared with the SQL side
// (REQ §13.88/§13.89, rule made precise 2026-09-16; docs/TODO.md "Code review
// 2026-09-24" R11). "Which one-way legs pair into a relay pair on one car vs.
// become a standalone chauffeur ride" is decided twice: here, by
// src/solver/relay.ts (pairRelays / chauffeurUnpairedRelayLegs) as part of
// the pure solve(); and in SQL by pair_one_way_legs()/try_widen_one_way_leg()
// inside assert_car_chain (supabase/migrations/20260916100000_car_chain_one_way_healing.sql),
// exercised against a real database by scripts/test-pairing-parity.mjs using
// the very same supabase/tests/fixtures/one_way_pairing_cases.json. Reading a
// JSON fixture from a test file does not violate the solver-purity rule
// (hard rule 5) -- that rule applies to src/solver's own non-test code.
//
// A case whose two implementations genuinely disagree is marked
// `knownDivergence` in the fixture and skipped here (`it.skip`) rather than
// "fixed" on either side -- see the fixture file and the review report for
// the full list of differences found.

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { solve } from '../index';
import type { Assignment, Request, SolverInput, SolverOutput } from '../types';
import { baseInput, flex, makeCar, makeRequest, noFlex, slotMs } from '../__fixtures__/gen';

interface LegFixture {
  departSlot?: number;
  returnSlot?: number;
  canDrive: boolean;
  companionCanDrive?: boolean;
  destination?: string;
  /** O3 (REQ §13.93, ORIGINS_PLAN §3): 'home' (default) | 'destA' | 'destB'. */
  origin?: string;
  /** O3: undefined -> effectiveTripType() derives 'drop_off' from the legacy one_way_to/one_way_from shape, same as everywhere else. */
  tripType?: 'round_trip' | 'one_way' | 'drop_off';
  flexEarlierMin?: number;
  flexLaterMin?: number;
}

interface CaseFixture {
  id: string;
  description: string;
  destination?: string;
  out: LegFixture | null;
  return: LegFixture | null;
  expectedSql: { out?: string; return?: string };
  expectedTs: { out?: string; return?: string };
  knownDivergence: string | null;
}

interface FixtureFile {
  config: { turnaroundMinutes: number; dwellMinutes: number; destinations: Record<string, { travelMinutes: number }> };
  cases: CaseFixture[];
}

function loadFixtures(): FixtureFile {
  const url = new URL('../../../supabase/tests/fixtures/one_way_pairing_cases.json', import.meta.url);
  return JSON.parse(readFileSync(url, 'utf8')) as FixtureFile;
}

const fixture = loadFixtures();

function buildRequests(c: CaseFixture): Request[] {
  const requests: Request[] = [];
  if (c.out) {
    const out = c.out;
    requests.push(
      makeRequest({
        id: `${c.id}-out`,
        tripShape: 'one_way_to',
        destinationId: out.destination ?? c.destination ?? 'destA',
        originId: out.origin && out.origin !== 'home' ? out.origin : undefined,
        tripType: out.tripType,
        departureMs: slotMs(out.departSlot!),
        canDrive: out.canDrive,
        drivingCompanionIds: out.companionCanDrive ? ['comp'] : undefined,
        flexDeparture: flex(out.flexEarlierMin ?? 0, out.flexLaterMin ?? 0),
        flexReturn: noFlex(),
      }),
    );
  }
  if (c.return) {
    const ret = c.return;
    requests.push(
      makeRequest({
        id: `${c.id}-return`,
        tripShape: 'one_way_from',
        destinationId: ret.destination ?? c.destination ?? 'destA',
        originId: ret.origin && ret.origin !== 'home' ? ret.origin : undefined,
        tripType: ret.tripType,
        returnMs: slotMs(ret.returnSlot!),
        canDrive: ret.canDrive,
        drivingCompanionIds: ret.companionCanDrive ? ['comp'] : undefined,
        flexDeparture: noFlex(),
        flexReturn: flex(ret.flexEarlierMin ?? 0, ret.flexLaterMin ?? 0),
      }),
    );
  }
  return requests;
}

type Outcome = 'relay_pair' | 'chauffeur' | 'unmet' | 'missing' | `other:${string}`;

function outcomeFor(output: SolverOutput, requestId: string): Outcome {
  const assignment: Assignment | undefined = output.assignments.find((a) => a.servedRequestIds.includes(requestId));
  if (assignment) {
    if (assignment.reasonCode === 'PLACED_RELAY_PAIR') return 'relay_pair';
    // A chauffeur ride is the same outcome whether it lacks a returner or a driver (Q7).
    if (assignment.legs.some((l) => l.requestId === requestId && l.carMode === 'chauffeur')) return 'chauffeur';
    return `other:${assignment.reasonCode}`;
  }
  if (output.unmet.some((u) => u.requestId === requestId)) return 'unmet';
  return 'missing';
}

function runCase(c: CaseFixture): { output: SolverOutput; input: SolverInput } {
  // Two shared cars: a case whose two legs heal into two *independent*
  // chauffeur rides (e.g. different destinations) must not be starved of a
  // second car just because this harness reuses one car per case.
  //
  // O3 (REQ §13.93, ORIGINS_PLAN §3): a non-home `origin` needs an actual car positioned
  // there to begin with -- unlike the SQL side's test harness (scripts/test-pairing-parity.mjs),
  // which always force-creates a feasible-looking lone chauffeur placeholder at the leg's own
  // origin regardless of whether a car starts there, solve() builds placement from scratch via
  // real car timelines. C1 starts at the out leg's own origin when it is explicit and non-home
  // (the realistic precondition for a drop_off pair/chauffeur placement to be possible there at
  // all); C2 stays at home, covering a case whose other leg's origin is home.
  const outOrigin = c.out?.origin && c.out.origin !== 'home' ? c.out.origin : undefined;
  const input = baseInput({
    cars: [makeCar('C1', outOrigin ? { startLocationId: outOrigin } : {}), makeCar('C2')],
    requests: buildRequests(c),
  });
  return { output: solve(input), input };
}

describe('one-way pairing parity golden cases (REQ §13.88/§13.89, R11)', () => {
  for (const c of fixture.cases) {
    const title = `${c.id}: ${c.description}`;
    const test = c.knownDivergence ? it.skip : it;
    test(c.knownDivergence ? `${title} [SKIPPED - knownDivergence: ${c.knownDivergence}]` : title, () => {
      const { output } = runCase(c);
      if (c.out) {
        expect(outcomeFor(output, `${c.id}-out`)).toBe(c.expectedTs.out);
      }
      if (c.return) {
        expect(outcomeFor(output, `${c.id}-return`)).toBe(c.expectedTs.return);
      }
    });
  }

  // Documents the fixture's own consistency requirement: any case actually
  // marked knownDivergence must have expectedSql !== expectedTs on at least
  // one leg (otherwise there is nothing to diverge on and the flag is stale).
  it('every knownDivergence case actually differs between expectedSql and expectedTs', () => {
    for (const c of fixture.cases) {
      if (!c.knownDivergence) continue;
      const differs = c.expectedSql.out !== c.expectedTs.out || c.expectedSql.return !== c.expectedTs.return;
      expect(differs, `${c.id} is marked knownDivergence but expectedSql/expectedTs agree`).toBe(true);
    }
  });

  it('every non-divergent case has expectedSql === expectedTs on every leg it declares', () => {
    for (const c of fixture.cases) {
      if (c.knownDivergence) continue;
      if (c.out) expect(c.expectedSql.out, c.id).toBe(c.expectedTs.out);
      if (c.return) expect(c.expectedSql.return, c.id).toBe(c.expectedTs.return);
    }
  });
});
