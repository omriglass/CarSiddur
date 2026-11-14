// src/solver/freedSlotRun.ts
//
// FC1 (owner 2026-11-14, REQ item 231): one ranking for a freed car. The SQL function `freed_slot_rank_input()`
// returns everything the ranking needs as plain JSON (epoch ms, ids, settings); this module turns it into the
// `matchFreedSlot()` input, ranks, builds the Sadran's options, and says what `resolve_freed_offer()` will do with
// them. The on-ride-cancelled edge function and the browser's "what will this change cause" line both call
// `runFreedSlot()`, so the line shown before a change cannot drift from what happens after it.
// Pure: no wall-clock arithmetic — every time arrives as epoch ms and becomes a 15-minute slot from the week start.

import { freedSlotOptions, matchFreedSlot } from './live';
import type { FreedSlotInput } from './live';
import { minutesToSlots } from './slots';
import { buildTimelines } from './timeline';
import type { Car, DayBounds, Destination, Flexibility, Passengers, Policy, Request, SolverConfig, TravelEdge, Window } from './types';

const SLOT_MS = 15 * 60 * 1000;
const DAY_SLOTS = 96;
/** REQ §13.168: the offer keeps the best options only. */
export const MAX_STORED_FREED_OPTIONS = 30;

export interface FreedSlotRawCandidate {
  id: string;
  memberId: string;
  name: string;
  departmentId: string;
  destinationId: string;
  rideType: string;
  tripShape: Request['tripShape'];
  tripType: NonNullable<Request['tripType']>;
  originId: string | null;
  originIsFreeText: boolean;
  departureMs: number | null;
  returnMs: number | null;
  flexDeparture: Flexibility;
  flexReturn: Flexibility;
  durationLocked: boolean;
  passengers: Passengers;
  luggage: boolean;
  towHitch: boolean;
  needsCarAtDestination: boolean;
  submittedAtMs: number;
  isLate: boolean;
  manualBoost: number;
  manualBoostReason: string;
  planB: boolean;
  stops: { leg: 'out' | 'return'; locationId: string | null }[];
  fairnessDeficit: number;
}

/** The JSON `freed_slot_rank_input()` returns. */
export interface FreedSlotRaw {
  offer: { id: string; status: string; groupId: string | null; carId: string; startsMs: number; endsMs: number };
  freedLocationId: string;
  weekStartMs: number;
  dayEndTime: string;
  homeLocationId: string;
  settings: { turnaroundMinutes: number; chauffeurDwellMinutes: number; detourMaxMinutes: number; detourMaxKm: number; stopMinutes: number | null };
  policy: Policy | null;
  car: {
    id: string; name: string; type: Car['type']; ownerMemberId: string | null; features: string[];
    baseLocationId: string | null; startLocationId: string | null;
    seatConfigs: Passengers[]; maintenance: { startsMs: number; endsMs: number }[];
  } | null;
  otherRides: {
    id: string; seriesId: string | null; startsMs: number; endsMs: number; originId: string; destinationId: string;
    overnightAck: boolean; locationNeutral: boolean;
  }[];
  travel: { fromId: string; toId: string; distanceKm: number | null; travelMinutes: number | null }[];
  destinations: { id: string; name: string | null; zone: string; distanceKm: number | null; travelMinutes: number | null; publicTransportScore: number | null }[];
  candidates: FreedSlotRawCandidate[];
  priorityRequestIds: string[];
  group: { id: string; members: { requestId: string; name: string }[] } | null;
}

/** What `resolve_freed_offer()` does with the ranking (REQ §13.168, §13.101 i). */
export type FreedSlotOutcome =
  /** nobody waiting can take it */
  | { kind: 'none' }
  /** the offer is held for an open contested group (REQ §13.101 i) — nothing is ranked now */
  | { kind: 'held' }
  /** one obvious candidate gets the car */
  | { kind: 'auto'; requestId: string; name: string }
  /** an open contested group gets the car first: its undecided members discuss it */
  | { kind: 'group'; requestIds: string[]; names: string[] }
  /** several candidates (or a lone plan B): the Sadran decides from the options */
  | { kind: 'sadran'; requestIds: string[]; names: string[] };

export interface FreedSlotRunResult {
  ranked: { requestId: string; requesterId: string; score: number; reason: string }[];
  /** Ready for `resolve_freed_offer(p_options)`. */
  options: { request_ids: string[]; score: number; unused_minutes: number; plan_b: number; recommended: boolean }[];
  outcome: FreedSlotOutcome;
}

const toSlotFloor = (ms: number, weekStartMs: number) => Math.floor((ms - weekStartMs) / SLOT_MS);
const toSlotCeil = (ms: number, weekStartMs: number) => Math.ceil((ms - weekStartMs) / SLOT_MS);

/** The solver's `week.days`: seven fixed 96-slot days from the week start, as the edge function always built them. */
export function freedWeekDays(dayEndTime: string): DayBounds[] {
  const [hh, mm] = dayEndTime.split(':');
  const dayEndOffset = minutesToSlots(Number(hh) * 60 + Number(mm ?? 0));
  return Array.from({ length: 7 }, (_, i) => ({
    dayIndex: i as DayBounds['dayIndex'],
    startSlot: i * DAY_SLOTS,
    endSlot: i * DAY_SLOTS + DAY_SLOTS,
    dayEndSlot: i * DAY_SLOTS + Math.min(dayEndOffset, DAY_SLOTS - 1),
  }));
}

/** The `matchFreedSlot()` input for a raw ranking input (null when the car or the policy is missing). */
export function freedSlotInputFrom(raw: FreedSlotRaw): { input: FreedSlotInput; freedWindow: Window; bufferSlots: number } | null {
  if (!raw.car || !raw.policy) return null;
  const weekStartMs = raw.weekStartMs;
  const days = freedWeekDays(raw.dayEndTime);
  const weekSlots = days[days.length - 1]!.endSlot;
  const config: SolverConfig = {
    bufferMinutes: raw.settings.turnaroundMinutes,
    detour: { maxMinutes: raw.settings.detourMaxMinutes, maxKm: raw.settings.detourMaxKm },
    beyondFlexMaxMinutes: 120,
    defaultTravelMinutes: 60,
    chauffeurDwellMinutes: raw.settings.chauffeurDwellMinutes,
    ...(raw.settings.stopMinutes != null ? { stopMinutes: raw.settings.stopMinutes } : {}),
    improvementBudget: 5000,
    perRequestBudget: 200,
    externalHints: { cabMaxMinutes: 90, rentalMinHours: 30, ptMinScore: 0.6 },
  };
  const features = raw.car.features ?? [];
  const car: Car = {
    id: raw.car.id,
    name: raw.car.name,
    type: raw.car.type,
    ...(raw.car.ownerMemberId ? { ownerMemberId: raw.car.ownerMemberId } : {}),
    seatConfigs: raw.car.seatConfigs,
    features,
    // REQ §13.101 (a): a car with the `large_trunk` feature takes large luggage (yes/no).
    luggageCapacity: features.includes('large_trunk') ? 1 : 0,
    ...(features.includes('tow_hitch') ? { towHitch: true } : {}),
    maintenance: raw.car.maintenance.map((b) => ({
      start: Math.max(0, toSlotFloor(b.startsMs, weekStartMs)),
      end: Math.min(weekSlots, toSlotCeil(b.endsMs, weekStartMs)),
    })),
    startLocationId: raw.car.startLocationId ?? raw.homeLocationId,
    ...(raw.car.baseLocationId ? { baseLocationId: raw.car.baseLocationId } : {}),
  };
  const bufferSlots = minutesToSlots(config.bufferMinutes);
  const timeline = buildTimelines([car], bufferSlots, weekSlots, raw.homeLocationId).get(car.id)!;
  for (const ride of raw.otherRides) {
    timeline.forceAdd({
      rideId: ride.id,
      // REQ §13.100 (QB1/QB7): a series' consecutive-day pieces are contiguous by construction (no buffer).
      ...(ride.seriesId ? { seriesId: ride.seriesId } : {}),
      window: { start: toSlotFloor(ride.startsMs, weekStartMs), end: toSlotCeil(ride.endsMs, weekStartMs) },
      startLocationId: ride.originId,
      endLocationId: ride.destinationId,
      overnightAck: ride.overnightAck,
      ...(ride.locationNeutral ? { locationNeutral: true } : {}),
    });
  }
  const destinations: Record<string, Destination> = {};
  for (const d of raw.destinations) {
    destinations[d.id] = {
      id: d.id,
      ...(d.name != null ? { name: d.name } : {}),
      zone: d.zone,
      ...(d.distanceKm != null ? { distanceKm: Number(d.distanceKm) } : {}),
      ...(d.travelMinutes != null ? { travelMinutes: d.travelMinutes } : {}),
      ...(d.publicTransportScore != null ? { publicTransportScore: d.publicTransportScore / 5 } : {}),
    } as Destination;
  }
  if (!destinations[raw.homeLocationId]) destinations[raw.homeLocationId] = { id: raw.homeLocationId, zone: 'home' } as Destination;
  const candidates: Request[] = raw.candidates.map((c) => ({
    id: c.id,
    memberId: c.memberId,
    departmentId: c.departmentId,
    destinationId: c.destinationId,
    rideType: c.rideType,
    tripShape: c.tripShape,
    ...(c.originId ? { originId: c.originId } : {}),
    originIsFreeText: c.originIsFreeText,
    tripType: c.tripType,
    ...(c.departureMs != null ? { departureMs: c.departureMs } : {}),
    ...(c.returnMs != null ? { returnMs: c.returnMs } : {}),
    flexDeparture: c.flexDeparture,
    flexReturn: c.flexReturn,
    ...(c.durationLocked ? { durationLocked: true } : {}),
    passengers: c.passengers,
    coRiderMemberIds: [],
    luggage: c.luggage,
    ...(c.towHitch ? { towHitch: true } : {}),
    needsCarAtDestination: c.needsCarAtDestination,
    submittedAtMs: c.submittedAtMs,
    isLate: c.isLate,
    ...(c.manualBoost > 0 ? { manualBoost: { value: c.manualBoost, reason: c.manualBoostReason } } : {}),
    ...(c.stops.length ? { stops: c.stops.map((s) => (s.locationId ? { leg: s.leg, locationId: s.locationId } : { leg: s.leg })) } : {}),
  }));
  for (const r of candidates) {
    if (!destinations[r.destinationId]) destinations[r.destinationId] = { id: r.destinationId, zone: 'unknown' } as Destination;
  }
  const freedWindow = { start: toSlotFloor(raw.offer.startsMs, weekStartMs), end: toSlotCeil(raw.offer.endsMs, weekStartMs) };
  const travel: TravelEdge[] = raw.travel.map((t) => ({
    fromId: t.fromId,
    toId: t.toId,
    ...(t.distanceKm != null ? { distanceKm: Number(t.distanceKm) } : {}),
    ...(t.travelMinutes != null ? { travelMinutes: t.travelMinutes } : {}),
  }));
  const fairness: Record<string, { deficit: number }> = {};
  for (const c of raw.candidates) fairness[c.memberId] = { deficit: Number(c.fairnessDeficit) };
  return {
    input: {
      car,
      timeline,
      freedWindow,
      freedLocationId: raw.freedLocationId ?? raw.homeLocationId,
      candidates,
      destinations,
      policy: raw.policy,
      stats: { fairness, usualCarId: {} },
      config,
      week: { startMs: weekStartMs, days },
      homeLocationId: raw.homeLocationId,
      travel,
    },
    freedWindow,
    bufferSlots,
  };
}

/** Rank a freed car, build the Sadran's options, and say what resolve_freed_offer will do with them. */
export function runFreedSlot(raw: FreedSlotRaw): FreedSlotRunResult {
  if (raw.offer.status === 'open' && raw.offer.groupId) return { ranked: [], options: [], outcome: { kind: 'held' } };
  const built = raw.candidates.length ? freedSlotInputFrom(raw) : null;
  if (!built) return { ranked: [], options: [], outcome: { kind: 'none' } };
  const { input, freedWindow, bufferSlots } = built;
  const byId = new Map(raw.candidates.map((c) => [c.id, c]));
  const matched = matchFreedSlot(input, { priorityRequestIds: raw.priorityRequestIds });
  const ranked = matched.map((c) => ({ requestId: c.requestId, requesterId: byId.get(c.requestId)?.memberId ?? '', score: c.score, reason: c.reason }));

  // REQ §13.168: every way to use the gap — one request, or several one after another at their own times.
  const requestById = new Map(input.candidates.map((r) => [r.id, r]));
  const items = matched.flatMap((c) => {
    const r = requestById.get(c.requestId);
    if (!r) return [];
    // REQ §13.193: a one-leg drop-off has one time; its chauffeur ride (the matcher's window) is what it takes of the gap
    const window = r.departureMs !== undefined && r.returnMs !== undefined
      ? { start: toSlotFloor(r.departureMs, raw.weekStartMs), end: toSlotCeil(r.returnMs, raw.weekStartMs) }
      : c.window;
    return [{ requestId: c.requestId, window, score: c.score, planB: byId.get(c.requestId)?.planB ?? false }];
  });
  const options = freedSlotOptions(items, freedWindow, bufferSlots).slice(0, MAX_STORED_FREED_OPTIONS).map((o) => ({
    request_ids: o.requestIds,
    score: Math.round(o.score * 10000) / 10000,
    unused_minutes: o.unusedSlots * 15,
    plan_b: o.planB,
    recommended: o.recommended,
  }));

  const nameOf = (id: string) => byId.get(id)?.name ?? '';
  let outcome: FreedSlotOutcome;
  const groupMembers = raw.group?.members ?? [];
  if (ranked.length && groupMembers.some((m) => ranked.some((c) => c.requestId === m.requestId))) {
    outcome = { kind: 'group', requestIds: groupMembers.map((m) => m.requestId), names: groupMembers.map((m) => m.name) };
  } else if (ranked.length === 0) {
    outcome = { kind: 'none' };
  } else if (ranked.length === 1 && !byId.get(ranked[0]!.requestId)?.planB) {
    outcome = { kind: 'auto', requestId: ranked[0]!.requestId, name: nameOf(ranked[0]!.requestId) };
  } else {
    outcome = { kind: 'sadran', requestIds: ranked.map((c) => c.requestId), names: ranked.map((c) => nameOf(c.requestId)) };
  }
  return { ranked, options, outcome };
}
