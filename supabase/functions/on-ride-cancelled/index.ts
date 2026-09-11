// supabase/functions/on-ride-cancelled/index.ts
//
// Freed-slot matching (REQUIREMENTS §8; ARCHITECTURE.md §6.3, §11 row
// "on-ride-cancelled"). Invoked by `cancel_ride()` via pg_net
// (`supabase/migrations/20260907091500_rpc.sql`, `on_ride_cancelled_url` app
// setting) with `{ offer_id }` and header `x-cron-secret` — this function
// rejects anything else (`verify_jwt = false` in supabase/config.toml, since
// pg_net sends no user JWT; ARCHITECTURE.md §8).
//
// Pipeline: load the offer + the pre-filtered candidates from the SQL
// `freed_slot_candidates(offer_id)` (DATA_MODEL.md §7.2), build a
// SolverInput-compatible structure from the department's cars/policy/week and
// this car's remaining timeline, rank with the bundled solver's
// `matchFreedSlot()` (SOLVER.md §5.2), and hand the ranked list to
// `resolve_freed_offer()` — which does the actual writes (0 -> closed; 1 ->
// auto-assign + notify; >1 -> notify all + Sadran contest), per REQUIREMENTS §8.
// `enqueue_notification` is called by that RPC, not by this function.

import { corsHeaders, handleCorsPreflight } from '../_shared/cors.ts';
import { buildWeekDays, minutesToSlots, toSlotCeil, toSlotFloor, zonedMidnightMs } from '../_shared/tz.ts';
import { errorResponse, jsonResponse, optionalEnv, timingSafeEqual } from '../_shared/env.ts';
import { getServiceRoleClient } from '../_shared/supabaseAdmin.ts';
import { buildTimelines, matchFreedSlot } from '../_shared/solver.js';

// NOTE: types below are a hand-written, intentionally minimal mirror of the
// subset of src/solver/types.ts this function constructs (Car, Destination,
// Policy, SolverConfig, SolverStats, FreedSlotInput/Request as used by
// matchFreedSlot — SOLVER.md §2, §5.2). The bundle step emits only
// `_shared/solver.js` (no declaration files: Deno's strict resolver cannot
// load a tsc-emitted .d.ts tree, and nothing else needed them). If
// src/solver/types.ts changes, update this block to match.
interface Passengers {
  adults: number;
  childSeats: number;
  boosters: number;
}
interface Destination {
  id: string;
  zone: string;
  distanceKm?: number;
  travelMinutes?: number;
  publicTransportScore?: number;
}
interface Car {
  id: string;
  name: string;
  type: 'shared' | 'temporary';
  ownerMemberId?: string;
  seatConfigs: Passengers[];
  features: string[];
  luggageCapacity: number;
  maintenance: { start: number; end: number }[];
  startLocationId?: string;
}
interface PolicyRuleConfig {
  type: string;
  weight: number;
  params: unknown;
}
interface Policy {
  id: string;
  version: number;
  rules: PolicyRuleConfig[];
}
interface SolverStats {
  fairness: Record<string, { deficit: number }>;
  usualCarId: Record<string, string>;
}
interface SolverConfig {
  bufferMinutes: number;
  detour: { maxMinutes: number; maxKm: number };
  beyondFlexMaxMinutes: number;
  defaultTravelMinutes: number;
  chauffeurDwellMinutes: number;
  improvementBudget: number;
  perRequestBudget: number;
  externalHints: { cabMaxMinutes: number; rentalMinHours: number; ptMinScore: number };
}
interface SolverRequest {
  id: string;
  memberId: string;
  departmentId: string;
  destinationId: string;
  rideType: string;
  tripShape: 'round_trip' | 'one_way_to' | 'one_way_from';
  departureMs?: number;
  returnMs?: number;
  flexDeparture: { earlierMin: number | 'day'; laterMin: number | 'day' };
  flexReturn: { earlierMin: number | 'day'; laterMin: number | 'day' };
  passengers: Passengers;
  coRiderMemberIds: string[];
  luggage: boolean;
  needsCarAtDestination: boolean;
  submittedAtMs: number;
  isLate: boolean;
  manualBoost?: { value: number; reason: string };
}
/** Structural subset of src/solver/timeline.ts's `CarTimeline` this function actually calls. */
interface CarTimelineLike {
  forceAdd(block: {
    rideId: string;
    window: { start: number; end: number };
    startLocationId: string;
    endLocationId: string;
    overnightAck: boolean;
  }): void;
}
interface FreedSlotInput {
  car: Car;
  timeline: CarTimelineLike;
  freedWindow: { start: number; end: number };
  freedLocationId: string;
  candidates: SolverRequest[];
  destinations: Record<string, Destination>;
  policy: Policy;
  stats: SolverStats;
  config: SolverConfig;
  week: { startMs: number; days: ReturnType<typeof buildWeekDays> };
  homeLocationId: string;
}

const DEFAULT_LOOKBACK_WEEKS = 3;

/** Parses the six domain values of requests.flex_* (interval columns) as PostgREST/postgres-style text. */
function parseFlexInterval(raw: string | null | undefined): number | 'day' {
  if (!raw) return 0;
  const dayMatch = raw.match(/(-?\d+)\s+day/);
  const timeMatch = raw.match(/(\d+):(\d+):(\d+(?:\.\d+)?)/);
  if (dayMatch && !timeMatch) return 'day';
  let minutes = 0;
  if (dayMatch) minutes += Number(dayMatch[1]) * 24 * 60;
  if (timeMatch) minutes += Number(timeMatch[1]) * 60 + Number(timeMatch[2]) + Number(timeMatch[3]) / 60;
  return Math.round(minutes);
}

interface OfferRow {
  id: string;
  department_id: string;
  week_start: string;
  car_id: string;
  cancelled_ride_id: string;
  starts_at: string;
  ends_at: string;
  status: string;
}

Deno.serve(async (req) => {
  const preflight = handleCorsPreflight(req);
  if (preflight) return preflight;
  if (req.method !== 'POST') return errorResponse(405, 'method_not_allowed', 'שיטה לא נתמכת', corsHeaders);

  const cronSecret = optionalEnv('CRON_SECRET');
  const headerSecret = req.headers.get('x-cron-secret') ?? '';
  if (!cronSecret || !timingSafeEqual(headerSecret, cronSecret)) {
    return errorResponse(401, 'not_authorized', 'לא מורשה', corsHeaders);
  }

  let body: { offer_id?: string };
  try {
    body = await req.json();
  } catch {
    return errorResponse(400, 'invalid_body', 'גוף בקשה לא תקין', corsHeaders);
  }
  if (!body.offer_id) return errorResponse(400, 'invalid_body', 'חסר offer_id', corsHeaders);

  const client = getServiceRoleClient();

  const { data: offer, error: offerError } = await client
    .from('freed_slot_offers')
    .select('id, department_id, week_start, car_id, cancelled_ride_id, starts_at, ends_at, status')
    .eq('id', body.offer_id)
    .maybeSingle<OfferRow>();
  if (offerError) return errorResponse(500, 'db_error', offerError.message, corsHeaders);
  if (!offer) return errorResponse(404, 'offer_not_found', 'ההצעה לא נמצאה', corsHeaders);
  if (offer.status !== 'open') {
    // Idempotent: a retried pg_net delivery or a Sadran action may have resolved this already.
    return jsonResponse({ skipped: true, reason: 'offer_not_open', status: offer.status }, { headers: corsHeaders });
  }

  const { data: cancelledRide } = await client
    .from('rides')
    .select('origin_id, destination_id')
    .eq('id', offer.cancelled_ride_id)
    .maybeSingle();
  const freedLocationId = (cancelledRide?.origin_id as string | undefined) ?? (cancelledRide?.destination_id as string | undefined);

  // Pre-filtered candidates (round trip, same dept/week, waitlisted/denied, not opted out,
  // window overlaps the freed slot, fits the car) — DATA_MODEL.md §7.2.
  const { data: candidateRows, error: candidatesError } = await client.rpc('freed_slot_candidates', {
    _offer: offer.id,
  });
  if (candidatesError) return errorResponse(500, 'db_error', candidatesError.message, corsHeaders);

  const candidates = (candidateRows ?? []) as { request_id: string; requester_id: string; fits: boolean; slack: string }[];

  async function resolve(ranked: { request_id: string; requester_id: string }[]) {
    const { error } = await client.rpc('resolve_freed_offer', { p_offer_id: offer.id, p_ranked_candidates: ranked });
    if (error) throw new Error(error.message);
  }

  if (candidates.length === 0) {
    await resolve([]);
    return jsonResponse({ offerId: offer.id, outcome: 'closed', candidates: 0 }, { headers: corsHeaders });
  }

  const candidateIds = candidates.map((c) => c.request_id);
  const requesterById = new Map(candidates.map((c) => [c.request_id, c.requester_id]));

  const [{ data: requestRows }, { data: carRow }, { data: seatConfigs }, { data: maintenanceBlocks }, { data: department }, { data: settings }, { data: otherRides }] =
    await Promise.all([
      client
        .from('requests')
        .select(
          'id, requester_id, department_id, destination_id, destination_text, trip_shape, depart_at, return_at, ' +
            'adults, child_seats, boosters, has_luggage, needs_car_at_destination, ' +
            'flex_depart_early, flex_depart_late, flex_return_early, flex_return_late, ' +
            'submitted_at, created_at, is_late, manual_boost, manual_boost_reason, ride_types(code)',
        )
        .in('id', candidateIds),
      client.from('cars').select('id, name, type, owner_id, features').eq('id', offer.car_id).maybeSingle(),
      client.from('car_seat_configs').select('adults, child_seats, boosters').eq('car_id', offer.car_id),
      client
        .from('car_maintenance_blocks')
        .select('starts_at, ends_at')
        .eq('car_id', offer.car_id)
        .gte('ends_at', offer.starts_at)
        .lte('starts_at', offer.ends_at),
      client.from('departments').select('home_destination_id').eq('id', offer.department_id).maybeSingle(),
      client
        .from('department_settings')
        .select('turnaround_minutes, day_end_time, chauffeur_dwell_minutes, detour_limit_minutes, detour_limit_km')
        .eq('department_id', offer.department_id)
        .maybeSingle(),
      client
        .from('rides')
        .select('id, starts_at, ends_at, origin_id, destination_id, overnight_ack_by')
        .eq('car_id', offer.car_id)
        .eq('week_start', offer.week_start)
        .neq('status', 'cancelled')
        .neq('id', offer.cancelled_ride_id),
    ]);

  if (!carRow || !department || !settings) {
    return errorResponse(500, 'missing_reference_data', 'חסרים נתוני רכב/מחלקה/הגדרות', corsHeaders);
  }

  const homeLocationId = department.home_destination_id as string;

  // Active policy for the department, falling back to the global default (DATA_MODEL.md §3.4).
  let policyRow = (
    await client.from('policies').select('id, current_version_id').eq('department_id', offer.department_id).eq('is_active', true).maybeSingle()
  ).data;
  if (!policyRow) {
    policyRow = (await client.from('policies').select('id, current_version_id').is('department_id', null).eq('is_active', true).maybeSingle()).data;
  }
  if (!policyRow?.current_version_id) return errorResponse(500, 'no_active_policy', 'לא נמצאה מדיניות פעילה', corsHeaders);
  const { data: policyVersion } = await client
    .from('policy_versions')
    .select('version_no, rules')
    .eq('id', policyRow.current_version_id)
    .single();

  const policy: Policy = { id: policyRow.id, version: policyVersion?.version_no ?? 1, rules: (policyVersion?.rules ?? []) as Policy['rules'] };

  // Destinations referenced by the candidate requests + home.
  const destinationIds = new Set<string>([homeLocationId]);
  for (const r of requestRows ?? []) if (r.destination_id) destinationIds.add(r.destination_id as string);
  const { data: destinationRows } = await client
    .from('destinations')
    .select('id, zone, distance_km, travel_minutes, public_transport_score')
    .in('id', [...destinationIds]);
  const destinations: Record<string, Destination> = {};
  for (const d of destinationRows ?? []) {
    destinations[d.id as string] = {
      id: d.id as string,
      zone: d.zone as string,
      distanceKm: d.distance_km ?? undefined,
      travelMinutes: d.travel_minutes ?? undefined,
      publicTransportScore: d.public_transport_score != null ? (d.public_transport_score as number) / 5 : undefined,
    };
  }

  // Fairness stats proxy (SOLVER.md §5, fairness rule reads stats.fairness[memberId].deficit,
  // 0..1, higher = more deserving). fairness_stats() itself requires can_manage_week(), which is
  // auth.uid()-based and unavailable to a service-role caller with no user JWT, so this queries
  // the same history directly instead of via that RPC. unmet / (unmet + served), 0.5 (neutral)
  // with no history — a documented approximation of the real fairness computation, which lives
  // client-side once features/board/solverInput.ts exists (CLAUDE.md Conventions §"Statuses").
  const fairnessRule = policy.rules.find((r) => r.type === 'fairness');
  const lookbackWeeks = ((fairnessRule?.params as { lookbackWeeks?: number } | undefined)?.lookbackWeeks) ?? DEFAULT_LOOKBACK_WEEKS;
  const memberIds = [...new Set(candidates.map((c) => c.requester_id))];
  const lookbackStart = new Date(offer.week_start);
  lookbackStart.setUTCDate(lookbackStart.getUTCDate() - lookbackWeeks * 7);
  const { data: history } = await client
    .from('requests')
    .select('requester_id, status')
    .eq('department_id', offer.department_id)
    .in('requester_id', memberIds)
    .gte('week_start', lookbackStart.toISOString().slice(0, 10))
    .lt('week_start', offer.week_start)
    .in('status', ['assigned', 'merged', 'denied', 'waitlisted']);

  const fairness: SolverStats['fairness'] = {};
  for (const memberId of memberIds) {
    const rows = (history ?? []).filter((h) => h.requester_id === memberId);
    const served = rows.filter((h) => h.status === 'assigned' || h.status === 'merged').length;
    const unmet = rows.filter((h) => h.status === 'denied' || h.status === 'waitlisted').length;
    fairness[memberId] = { deficit: served + unmet > 0 ? unmet / (served + unmet) : 0.5 };
  }
  const stats: SolverStats = { fairness, usualCarId: {} };

  const config: SolverConfig = {
    bufferMinutes: settings.turnaround_minutes as number,
    detour: { maxMinutes: settings.detour_limit_minutes as number, maxKm: settings.detour_limit_km as number },
    beyondFlexMaxMinutes: 120,
    defaultTravelMinutes: 60,
    chauffeurDwellMinutes: settings.chauffeur_dwell_minutes as number,
    improvementBudget: 5000,
    perRequestBudget: 200,
    externalHints: { cabMaxMinutes: 90, rentalMinHours: 30, ptMinScore: 0.6 },
  };

  const weekStartMs = zonedMidnightMs(offer.week_start);
  const days = buildWeekDays(weekStartMs, (settings.day_end_time as string) ?? '23:59:00');
  const weekSlots = days[days.length - 1].endSlot;

  // Car: seat configs, maintenance clipped to this week, no known per-week luggage capacity
  // column in `cars` (DATA_MODEL.md §3.2 has no such field yet) — generous default so luggage
  // never blocks freed-slot matching; a documented gap, same spirit as DATA_MODEL.md §6.1's
  // own "Implementation status and deviations" notes.
  const seatConfigList: Passengers[] = (seatConfigs ?? []).map((s) => ({
    adults: s.adults as number,
    childSeats: s.child_seats as number,
    boosters: s.boosters as number,
  }));
  const maintenance = (maintenanceBlocks ?? []).map((b) => ({
    start: Math.max(0, toSlotFloor(Date.parse(b.starts_at as string), weekStartMs)),
    end: Math.min(weekSlots, toSlotCeil(Date.parse(b.ends_at as string), weekStartMs)),
  }));
  const car: Car = {
    id: carRow.id as string,
    name: carRow.name as string,
    type: carRow.type as Car['type'],
    ownerMemberId: (carRow.owner_id as string | undefined) ?? undefined,
    seatConfigs: seatConfigList,
    features: (carRow.features as string[]) ?? [],
    luggageCapacity: 999,
    maintenance,
    startLocationId: homeLocationId,
  };

  const bufferSlots = minutesToSlots(config.bufferMinutes);
  const timelines = buildTimelines([car], bufferSlots, weekSlots, homeLocationId);
  const timeline = timelines.get(car.id)!;
  for (const ride of otherRides ?? []) {
    timeline.forceAdd({
      rideId: ride.id as string,
      window: {
        start: toSlotFloor(Date.parse(ride.starts_at as string), weekStartMs),
        end: toSlotCeil(Date.parse(ride.ends_at as string), weekStartMs),
      },
      startLocationId: ride.origin_id as string,
      endLocationId: ride.destination_id as string,
      overnightAck: ride.overnight_ack_by != null,
    });
  }

  const solverRequests: SolverRequest[] = (requestRows ?? []).map((r) => ({
    id: r.id as string,
    memberId: r.requester_id as string,
    departmentId: r.department_id as string,
    destinationId: (r.destination_id as string | null) ?? `text:${r.destination_text}`,
    rideType: ((r.ride_types as { code?: string } | null)?.code) ?? 'other',
    tripShape: r.trip_shape as SolverRequest['tripShape'],
    departureMs: r.depart_at ? Date.parse(r.depart_at as string) : undefined,
    returnMs: r.return_at ? Date.parse(r.return_at as string) : undefined,
    flexDeparture: { earlierMin: parseFlexInterval(r.flex_depart_early as string), laterMin: parseFlexInterval(r.flex_depart_late as string) },
    flexReturn: { earlierMin: parseFlexInterval(r.flex_return_early as string), laterMin: parseFlexInterval(r.flex_return_late as string) },
    passengers: { adults: r.adults as number, childSeats: r.child_seats as number, boosters: r.boosters as number },
    coRiderMemberIds: [],
    luggage: r.has_luggage as boolean,
    needsCarAtDestination: r.needs_car_at_destination as boolean,
    submittedAtMs: Date.parse((r.submitted_at as string) ?? (r.created_at as string)),
    isLate: r.is_late as boolean,
    manualBoost: (r.manual_boost as number) > 0 ? { value: r.manual_boost as number, reason: (r.manual_boost_reason as string) ?? '' } : undefined,
  }));

  if (!destinations[homeLocationId]) destinations[homeLocationId] = { id: homeLocationId, zone: 'home' };
  for (const sr of solverRequests) {
    if (!destinations[sr.destinationId]) destinations[sr.destinationId] = { id: sr.destinationId, zone: 'unknown' };
  }

  const freedWindow = {
    start: toSlotFloor(Date.parse(offer.starts_at), weekStartMs),
    end: toSlotCeil(Date.parse(offer.ends_at), weekStartMs),
  };

  const matchInput: FreedSlotInput = {
    car,
    timeline,
    freedWindow,
    freedLocationId: freedLocationId ?? homeLocationId,
    candidates: solverRequests,
    destinations,
    policy,
    stats,
    config,
    week: { startMs: weekStartMs, days },
    homeLocationId,
  };

  const ranked = matchFreedSlot(matchInput);
  const rankedForRpc = ranked.map((c) => ({ request_id: c.requestId, requester_id: requesterById.get(c.requestId) ?? '' }));

  await resolve(rankedForRpc);

  return jsonResponse(
    {
      offerId: offer.id,
      outcome: rankedForRpc.length === 0 ? 'closed' : rankedForRpc.length === 1 ? 'auto_assigned' : 'pending_approval',
      candidates: rankedForRpc.length,
      ranked: ranked.map((c) => ({ requestId: c.requestId, score: c.score, reason: c.reason })),
    },
    { headers: corsHeaders },
  );
});
