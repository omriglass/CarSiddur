// A drop-off with a pickup is two separate trips (REQUIREMENTS §13.94,
// docs/SOLVER.md §1.3a): the drop-off and the later pickup are served
// independently (relay pair, chauffeur ride, passenger) and the requester never
// holds the car for the whole window — there is no `keep` fallback.
//
// Implemented as an input rewrite: every such request becomes two ordinary
// one-way `drop_off` requests (`<id>#out`, `<id>#ret`) before solving, and the
// output is mapped back to the original request id afterwards. Everything in
// between (pairing, chauffeur healing, merges, suggestions) therefore treats
// each leg exactly like a legacy one-way request.

import { effectiveTripType } from './travel';
import type { Assignment, Request, SolverInput, SolverOutput, Suggestion, UnmetRequest } from './types';

const OUT = '#out';
const RET = '#ret';

export function isSplitDropOff(r: Request, servedByFixed: ReadonlySet<string>): boolean {
  return (
    r.tripShape === 'round_trip' &&
    effectiveTripType(r) === 'drop_off' &&
    r.departureMs !== undefined &&
    r.returnMs !== undefined &&
    r.seriesId === undefined &&
    !r.originIsFreeText &&
    !servedByFixed.has(r.id)
  );
}

export interface SplitResult {
  input: SolverInput;
  /** original request ids that were split */
  splitIds: Set<string>;
}

export function expandDropOffs(input: SolverInput): SplitResult {
  const servedByFixed = new Set<string>();
  for (const fr of input.fixedRides) for (const id of fr.servedRequestIds) servedByFixed.add(id);
  const splitIds = new Set<string>();
  const requests: Request[] = [];
  for (const r of input.requests) {
    if (!isSplitDropOff(r, servedByFixed)) {
      requests.push(r);
      continue;
    }
    splitIds.add(r.id);
    requests.push({
      ...r,
      id: r.id + OUT,
      tripShape: 'one_way_to',
      tripType: 'drop_off',
      returnMs: undefined,
      stops: r.stops?.filter((s) => s.leg === 'out'),
    });
    requests.push({
      ...r,
      id: r.id + RET,
      tripShape: 'one_way_from',
      tripType: 'drop_off',
      departureMs: undefined,
      stops: r.stops?.filter((s) => s.leg === 'return'),
    });
  }
  if (splitIds.size === 0) return { input, splitIds };
  const previousAssignments = input.previousAssignments?.map((p) => ({
    ...p,
    servedRequestIds: p.servedRequestIds.flatMap((id) => (splitIds.has(id) ? [id + OUT, id + RET] : [id])),
  }));
  return { input: { ...input, requests, previousAssignments }, splitIds };
}

function baseId(id: string, splitIds: ReadonlySet<string>): string {
  for (const suffix of [OUT, RET]) {
    if (id.endsWith(suffix)) {
      const base = id.slice(0, -suffix.length);
      if (splitIds.has(base)) return base;
    }
  }
  return id;
}

function mapIds<T>(value: T, splitIds: ReadonlySet<string>): T {
  if (typeof value === 'string') return baseId(value, splitIds) as unknown as T;
  if (Array.isArray(value)) return value.map((v) => mapIds(v, splitIds)) as unknown as T;
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = mapIds(v, splitIds);
    return out as T;
  }
  return value;
}

function mergeUnmet(a: UnmetRequest, b: UnmetRequest): UnmetRequest {
  const suggestions: Suggestion[] = [...a.suggestions, ...b.suggestions];
  // one deny is enough: keep the last (both are identical in effect)
  const lastDeny = suggestions.map((s) => s.kind).lastIndexOf('deny');
  const kept = suggestions.filter((s, i) => s.kind !== 'deny' || i === lastDeny);
  const blockers = [...a.blockers];
  for (const bl of b.blockers) if (!blockers.some((x) => JSON.stringify(x) === JSON.stringify(bl))) blockers.push(bl);
  return { ...a, score: Math.max(a.score, b.score), blockers, suggestions: kept };
}

/** Maps a solve of the expanded input back to the original request ids. */
export function restoreDropOffIds(output: SolverOutput, splitIds: ReadonlySet<string>): SolverOutput {
  if (splitIds.size === 0) return output;
  const assignments: Assignment[] = output.assignments.map((a) => {
    const m = mapIds(a, splitIds);
    return { ...m, servedRequestIds: [...new Set(m.servedRequestIds)] };
  });
  const unmetById = new Map<string, UnmetRequest>();
  const unmet: UnmetRequest[] = [];
  for (const u of output.unmet) {
    const m = mapIds(u, splitIds);
    const prev = unmetById.get(m.requestId);
    if (prev) {
      const merged = mergeUnmet(prev, m);
      unmetById.set(m.requestId, merged);
      unmet[unmet.indexOf(prev)] = merged;
    } else {
      unmetById.set(m.requestId, m);
      unmet.push(m);
    }
  }
  unmet.sort((x, y) => (x.requestId < y.requestId ? -1 : x.requestId > y.requestId ? 1 : 0));
  const served = new Set<string>();
  for (const a of assignments) for (const id of a.servedRequestIds) served.add(id);
  return {
    ...output,
    assignments,
    unmet,
    mergeOpportunities: mapIds(output.mergeOpportunities, splitIds),
    warnings: mapIds(output.warnings, splitIds),
    stats: { ...output.stats, served: served.size, unmet: unmet.length },
  };
}
