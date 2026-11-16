import { supabase } from "@/integrations/supabase/client";
import { rpc, toAppError } from "@/lib/rpc";
import { withPersonBusyRetry } from "@/lib/personBusy";
import { withSmallTrunkRetry } from "@/lib/smallTrunk";
import { createWeekPartsBatcher, type WeekPartAnswer } from "@/lib/weekPartsBatcher";

import type { Database, Json } from "@/integrations/supabase/types";

import type { CarNeighbourRow } from "./carHandover";
import { parseLongDetour, type LongDetour } from "./mergeQuestions";
import { rideStretchesSchema, type RideStretches } from "./rideStretches";

/**
 * Shared ride-level pieces the `siddur` and `sadran` features both need (moved out of
 * `siddur/api.ts`/`sadran/servedOf.ts` — REFACTOR_BACKLOG "R8: break the siddur ⇄ sadran
 * import cycle"). The only file in the `rides` feature that calls `supabase.from`/`.rpc`.
 */
export type BoardRide = Database["public"]["Views"]["v_board_rides"]["Row"];

/**
 * The parts of one department-week `week_parts()` returns (PF1 DC2b, 20261112233000). Each is exactly the rows its
 * former own API call returned, under the caller's RLS; `scripts/qa/week-parts-oracle.mjs` holds that.
 */
export type WeekPart =
  | "week" | "rides" | "requests" | "proposals" | "freedOffers" | "heldNotices"
  | "carLocations" | "waitlistGroups" | "waitlistHolds" | "siddurWaitlist" | "rideChanges" | "liveEvents";

const weekParts = createWeekPartsBatcher({
  fetch: async (departmentId, weekStart, parts) => {
    const { data, error } = await supabase.rpc("week_parts", { p_department_id: departmentId, p_week_start: weekStart, p_parts: parts });
    if (error) throw error;
    return (data ?? {}) as unknown as Record<string, WeekPartAnswer | undefined>;
  },
});

/**
 * One part of a department-week. Reads that start together (a screen opening, the refresh after a change) share
 * one API call (`src/lib/weekPartsBatcher.ts`); a part's own error rejects only that part.
 */
export async function fetchWeekPart<T>(departmentId: string, weekStart: string, part: WeekPart): Promise<T> {
  try {
    return (await weekParts.read(departmentId, weekStart, part)) as T;
  } catch (error) {
    throw toAppError(error);
  }
}

export type RideChange = Database["public"]["Tables"]["ride_change_requests"]["Row"] & {
  requester: { full_name: string } | null;
  parties: Database["public"]["Tables"]["ride_change_parties"]["Row"][];
};

export interface RideMove {
  rideId: string;
  carId: string;
  startsAt: string;
  endsAt: string;
  expectedVersion: number;
}

/** R13M5: moves my request's people onto another ride (`joinable_rides_for_request`) and releases my seat on the held one. */
export async function joinOtherRide(requestId: string, rideId: string, expectedVersion: number): Promise<void> {
  await rpc("join_other_ride", { p_request_id: requestId, p_ride_id: rideId, p_expected_version: expectedVersion });
}

/** REQ §13.176: driving while on another ride at that time asks first (`withPersonBusyRetry`). */
export async function claimRideDriver(rideId: string, expectedVersion: number): Promise<void> {
  await withPersonBusyRetry((allowBusy) => rpc("claim_ride_driver", { p_ride_id: rideId, p_expected_version: expectedVersion, p_allow_busy: allowBusy }));
}

/** REQ §13.174: a volunteer driver steps down — the ride needs a driver again. */
export async function releaseRideDriver(rideId: string, expectedVersion: number): Promise<void> {
  await rpc("release_ride_driver", { p_ride_id: rideId, p_expected_version: expectedVersion });
}

/** REQ §13.174: the caller takes the wheel from the ride's volunteer driver (or claims it, if it lost its driver). */
export async function takeOverRideDriver(rideId: string, expectedVersion: number): Promise<void> {
  await withPersonBusyRetry((allowBusy) => rpc("take_over_ride_driver", { p_ride_id: rideId, p_expected_version: expectedVersion, p_allow_busy: allowBusy }));
}

/** REQ §13.129 (b): the driver hands their own ride to a driving companion/added passenger and leaves it. */
export async function handOverOwnRide(rideId: string, expectedVersion: number, newDriver: string): Promise<void> {
  await rpc("hand_over_own_ride", { p_ride_id: rideId, p_expected_version: expectedVersion, p_new_driver: newDriver });
}

/** REQ item 229: the driver (or the Sadran for them) leaves a merged ride — `newDriver` drives, or null = no driver. */
export async function leaveMergedRide(rideId: string, expectedVersion: number, newDriver: string | null): Promise<void> {
  await rpc("leave_merged_ride", { p_ride_id: rideId, p_expected_version: expectedVersion, ...(newDriver ? { p_new_driver: newDriver } : {}) });
}

/** R20B15: the hours a ride left with no driver would shrink to (those still on it), or null when nothing would change. */
export async function leaveRideFitPreview(rideId: string, expectedVersion: number, newDriver: string | null = null): Promise<{ startsAt: string; endsAt: string } | null> {
  // R19B2: with a new driver (a handover), the hours the riders still on it need
  const data = (await rpc("leave_ride_fit_preview", { p_ride_id: rideId, p_expected_version: expectedVersion, ...(newDriver ? { p_new_driver: newDriver } : {}) })) as { starts_at?: string; ends_at?: string } | null;
  return data?.starts_at && data.ends_at ? { startsAt: data.starts_at, endsAt: data.ends_at } : null;
}

/** R20B15: "לקצר" — leave with no driver and shrink the ride to the hours of those still on it, in one step. */
export async function leaveMergedRideFit(rideId: string, expectedVersion: number, newDriver: string | null = null): Promise<void> {
  await rpc("leave_merged_ride_fit", { p_ride_id: rideId, p_expected_version: expectedVersion, ...(newDriver ? { p_new_driver: newDriver } : {}) });
}

/**
 * O28-8: just these rides of the week, as `week_board_rides` returns them (`week_board_rides_subset`, same rows
 * and RLS) — a ride the caller can no longer see (e.g. cancelled) is simply absent.
 */
export async function fetchWeekRidesSubset(departmentId: string, weekStart: string, rideIds: readonly string[]): Promise<BoardRide[]> {
  const { data, error } = await supabase.rpc("week_board_rides_subset", {
    p_department_id: departmentId, p_week_start: weekStart, p_ride_ids: [...rideIds],
  });
  if (error) throw toAppError(error);
  return data ?? [];
}

/** Public ride information only; does not modify scheduling, passengers or consent. */
export async function updateRidePublicNotes(rideId: string, expectedVersion: number, notes: string | null): Promise<void> {
  await rpc("update_ride_public_notes", { p_ride_id: rideId, p_expected_version: expectedVersion, p_notes: notes ?? "" });
}

export async function fetchRideChanges(departmentId?: string, weekStart?: string, fromWeek?: string): Promise<RideChange[]> {
  // One department-week (the siddur and the board): a part of the week read.
  if (departmentId && weekStart && !fromWeek) return fetchWeekPart<RideChange[]>(departmentId, weekStart, "rideChanges");
  let query = supabase.from("ride_change_requests")
    .select("*, requester:profiles!ride_change_requests_requester_id_fkey(full_name), parties:ride_change_parties(*)")
    .eq("status", "pending");
  if (departmentId) query = query.eq("department_id", departmentId);
  if (weekStart) query = query.eq("week_start", weekStart);
  if (fromWeek) query = query.gte("week_start", fromWeek);
  const { data, error } = await query.order("created_at");
  if (error) throw toAppError(error);
  return (data ?? []) as RideChange[];
}

/** REQ §13.203 (b): one ride in the way of a move / a new request, and what its driver could give up. */
export interface MakeRoomParty {
  ride_id: string;
  driver_id: string;
  name: string;
  phone: string | null;
  starts_at: string;
  ends_at: string;
  /** The ride's new end if the driver returns earlier; null when that leaves no ride. */
  end_option: string | null;
  /** The ride's new start if the driver leaves later; null when that leaves no ride. */
  start_option: string | null;
  askable: boolean;
}
export type MakeRoomCut = "end" | "start" | "cancel";
export interface MakeRoomCar { car_id: string; car_name: string; parties: MakeRoomParty[] }

/** Moving my ride onto a taken slot: the rides in the way; `askable` = every one may be asked (REQ §13.203 b). */
export async function fetchMakeRoomOptions(move: Pick<RideMove, "rideId" | "carId" | "startsAt" | "endsAt">): Promise<{ askable: boolean; parties: MakeRoomParty[] }> {
  const data = await rpc("ride_shorten_options", { p_ride_id: move.rideId, p_car_id: move.carId, p_starts_at: move.startsAt, p_ends_at: move.endsAt });
  return data as unknown as { askable: boolean; parties: MakeRoomParty[] };
}

/** My new waiting-list round trip: up to three cars it could take if the rides in the way made room. */
export async function fetchMakeRoomOptionsForRequest(requestId: string): Promise<MakeRoomCar[]> {
  const data = await rpc("ride_shorten_options_for_request", { p_request_id: requestId });
  return (data ?? []) as unknown as MakeRoomCar[];
}

export type MakeRoomTarget =
  | { kind: "move"; move: RideMove }
  | { kind: "request"; requestId: string; carId: string };

/**
 * REQ §13.203 (a): asks the drivers in the way to make room, as agreed with them (`talked` is always true: the only
 * way here is "דיברתי עם X").
 */
export async function requestMakeRoom(target: MakeRoomTarget, cuts: { rideId: string; cut: MakeRoomCut }[]): Promise<string> {
  const p_cuts = cuts.map((entry) => ({ ride_id: entry.rideId, cut: entry.cut })) as unknown as Json;
  // Either a ride or a request: PostgREST wants every argument, so the unused ones go as SQL null.
  const none = null as unknown as string;
  if (target.kind === "request") {
    return rpc("request_ride_shorten", {
      p_ride_id: none, p_request_id: target.requestId, p_car_id: target.carId,
      p_starts_at: none, p_ends_at: none, p_expected_version: null as unknown as number, p_cuts, p_talked: true,
    });
  }
  const { move } = target;
  // REQ §13.111 (a): the driver accepts a car without a large trunk for their own large-luggage request ("לשבץ בכל זאת?").
  return withSmallTrunkRetry((allowSmallTrunk) => rpc("request_ride_shorten", {
    p_ride_id: move.rideId, p_request_id: none, p_car_id: move.carId,
    p_starts_at: move.startsAt, p_ends_at: move.endsAt, p_expected_version: move.expectedVersion,
    p_cuts, p_talked: true, p_allow_small_trunk: allowSmallTrunk,
  }));
}

export async function respondRideChange(changeId: string, accept: boolean): Promise<void> {
  await rpc("respond_ride_change", { p_change_id: changeId, p_accept: accept });
}

export async function cancelRideChange(changeId: string): Promise<void> {
  await rpc("cancel_ride_change", { p_change_id: changeId });
}

/**
 * Same row shape as `features/sadran/api.ts`'s `RidePassengerInput` (the Sadran board's
 * `set_ride_passengers()` *replace* editor) — kept as a separate local type rather than a
 * cross-feature import so each feature's `api.ts` stays the only place it calls `.rpc()` for
 * its own inputs.
 */
export interface RidePassengerInput {
  person_id?: string;
  child_id?: string;
  display_name: string;
  seat_kind: "adult" | "child_seat" | "booster";
  /** REQ §13.176: which way they ride (default the whole ride); their part of the ride follows it. */
  leg?: "out" | "return" | "both";
  /** REQ item 246 h: where they get on / off on the ride's route (absent = where the leg starts / ends); for a row
   * riding both ways the `return_*` places are the way back's. */
  board_place_id?: string;
  board_place_text?: string;
  alight_place_id?: string;
  alight_place_text?: string;
  return_board_place_id?: string;
  return_board_place_text?: string;
  return_alight_place_id?: string;
  return_alight_place_text?: string;
}

/** Appends named passengers to a ride's existing list (never replaces it); duplicates already on the ride or already served are silently skipped by the RPC. */
export async function addRidePassengers(rideId: string, expectedVersion: number, passengers: RidePassengerInput[]): Promise<void> {
  await rpc("add_ride_passengers", { p_ride_id: rideId, p_expected_version: expectedVersion, p_passengers: passengers as unknown as Json });
}

/**
 * Removes exactly one person from a ride's unified `v_board_rides.people` list, addressed by
 * that entry's `key` — any of `driver:`/`req:`/`comp:`/`child:`/`guest:`/`added:`, though the
 * driver's own entry always has `removable: false` and is never offered a remove control
 * (`RidePassengersList`/`ridePeople.ts`'s `canRemoveRidePerson`). 20260914190000_unified_
 * ride_people.sql replaced the narrower `remove_ride_passenger(uuid, int)`, which only took a
 * `ride_passengers.id`, with this key-based, ride-scoped RPC open to any approved department
 * member on a published/live week (or a Sadran/admin who manages it).
 */
/** REQ item 246 h: who rides which stretch of the ride and the free seats per stretch (`ride_stretches`), for the stops view. */
export async function fetchRideStretches(rideId: string): Promise<RideStretches> {
  const data = await rpc("ride_stretches", { p_ride_id: rideId });
  const parsed = rideStretchesSchema.safeParse(data);
  return parsed.success ? parsed.data : null;
}

/** REQ item 246 h: how someone on the ride rides it (`parts`: per leg null = not riding, else the board / alight places). */
export async function setRidePersonPart(rideId: string, expectedVersion: number, key: string, parts: Record<string, unknown>): Promise<void> {
  await rpc("set_ride_person_part", { p_ride_id: rideId, p_expected_version: expectedVersion, p_key: key, p_parts: parts as unknown as Json });
}

/** REQ item 246 h (phase 2d): a guest leaves someone else's ride; their request is their own again (placed or waiting). */
export async function leaveRideAsGuest(rideId: string, requestId: string, expectedVersion: number): Promise<{ request_status?: string; status?: string }> {
  const data = await rpc("leave_ride_as_guest", { p_ride_id: rideId, p_request_id: requestId, p_expected_version: expectedVersion });
  return (data ?? {}) as { request_status?: string; status?: string };
}

export async function removeRidePerson(rideId: string, expectedVersion: number, key: string): Promise<void> {
  await rpc("remove_ride_person", { p_ride_id: rideId, p_expected_version: expectedVersion, p_key: key });
}

/**
 * REQ §13.108 f: the ride before/after each given ride on its car (`v_ride_car_neighbours`, security_invoker —
 * a member only gets rows for rides RLS lets them see). One round trip for any number of rides.
 */
export async function fetchCarNeighbours(rideIds: readonly string[]): Promise<CarNeighbourRow[]> {
  if (rideIds.length === 0) return [];
  const { data, error } = await supabase.from("v_ride_car_neighbours").select("*").in("ride_id", [...rideIds]);
  if (error) throw toAppError(error);
  return data ?? [];
}

/**
 * What the week-grid Excel sheet needs beyond the rides (both exports, Sadran + archive):
 * every car of the department with its type (a private car is listed only when it has a ride),
 * the department home place (ride-label direction) and the board's first visible time.
 * `cars`, `departments` and `department_settings` are readable by any approved member.
 */
export interface ExportLayoutData {
  cars: { id: string; name: string; type: string | null; status?: string | null }[];
  departmentName: string | null;
  homeDestinationId: string | null;
  boardStartTime: string | null;
}
export async function fetchExportLayout(departmentId: string): Promise<ExportLayoutData> {
  const [cars, department, settings] = await Promise.all([
    supabase.from("cars").select("id, name, type, status").eq("department_id", departmentId).order("name"),
    supabase.from("departments").select("name, home_destination_id").eq("id", departmentId).maybeSingle(),
    supabase.from("department_settings").select("board_start_time").eq("department_id", departmentId).maybeSingle(),
  ]);
  if (cars.error) throw toAppError(cars.error);
  if (department.error) throw toAppError(department.error);
  if (settings.error) throw toAppError(settings.error);
  return { cars: cars.data ?? [], departmentName: department.data?.name ?? null, homeDestinationId: department.data?.home_destination_id ?? null, boardStartTime: settings.data?.board_start_time ?? null };
}

/** REQ §13.175 (d): the member's merge of a rider into the ride they drive — the server's verdict and the questions it needs. */
export interface MemberMergePreview {
  ok: boolean;
  code: string | null;
  leg: "out" | "return" | "both";
  guestName: string;
  longDetour: LongDetour | null;
  /** Only problems the member may accept (a long detour, a car without a large trunk). */
  waivable: boolean;
  /** A car without a large trunk for large luggage — accepted after "אני מודע/ת" (REQ §13.175 g). */
  luggageProblem: boolean;
  /** REQ §13.200: which car needs are missing (`luggageProblem` covers both); empty from an older server = large trunk. */
  needs: ("large_trunk" | "tow_hitch")[];
  joinerDepartAt: string | null;
  joinerReturnAt: string | null;
  wantedDepartAt: string | null;
  wantedReturnAt: string | null;
  waitStartsAt: string | null;
  waitEndsAt: string | null;
  /** The guest keeps their time as the ride is / once the ride stretches to it. */
  timeKept: boolean;
  waitKeepsTime: boolean;
  /** Applies without "we talked": as the ride is / stretched. */
  direct: boolean;
  directWithWait: boolean;
  sourceDriverName: string | null;
  otherRiders: string[];
  /** R19B1 (REQ item 220): the merged leg lands on the wrong side of the guest's other leg — asked, never refused. */
  order: { eta: string; wanted: string; leg: "out" | "return" } | null;
}

const isoOr = (value: unknown): string | null => (typeof value === "string" && value ? value : null);

export async function memberMergePreview(rideId: string, sourceRideId: string, requestId: string): Promise<MemberMergePreview> {
  const raw = (await rpc("member_merge_preview", { p_ride_id: rideId, p_source_ride_id: sourceRideId, p_request_id: requestId })) as Record<string, unknown>;
  return {
    ok: raw.ok === true,
    code: typeof raw.code === "string" ? raw.code : null,
    leg: raw.leg === "out" || raw.leg === "return" ? raw.leg : "both",
    guestName: typeof raw.guest_name === "string" ? raw.guest_name : "",
    longDetour: parseLongDetour(raw),
    waivable: raw.waivable === true,
    luggageProblem: raw.luggage_waivable === true,
    needs: Array.isArray(raw.needs) ? raw.needs.filter((n): n is "large_trunk" | "tow_hitch" => n === "large_trunk" || n === "tow_hitch") : [],
    joinerDepartAt: isoOr(raw.joiner_depart_at), joinerReturnAt: isoOr(raw.joiner_return_at),
    wantedDepartAt: isoOr(raw.joiner_old_depart_at), wantedReturnAt: isoOr(raw.joiner_old_return_at),
    waitStartsAt: isoOr(raw.wait_starts_at), waitEndsAt: isoOr(raw.wait_ends_at),
    timeKept: raw.time_kept === true, waitKeepsTime: raw.wait_keeps_time === true,
    direct: raw.direct === true, directWithWait: raw.direct_with_wait === true,
    sourceDriverName: isoOr(raw.source_driver_name),
    otherRiders: Array.isArray(raw.other_riders) ? raw.other_riders.filter((name): name is string => typeof name === "string") : [],
    order: raw.time_far_kind === "order" && typeof raw.time_far_eta === "string" && typeof raw.time_far_wanted === "string"
      ? { eta: raw.time_far_eta, wanted: raw.time_far_wanted, leg: raw.time_far_leg === "out" ? "out" : "return" } : null,
  };
}

export async function memberMergeRide(input: { rideId: string; sourceRideId: string; requestId: string; expectedVersion: number; wait: boolean; allowLongDetour: boolean; agreed: boolean; allowSmallTrunk: boolean }): Promise<void> {
  await rpc("member_merge_ride", {
    p_ride_id: input.rideId, p_source_ride_id: input.sourceRideId, p_request_id: input.requestId, p_expected_version: input.expectedVersion,
    p_wait: input.wait, p_allow_long_detour: input.allowLongDetour, p_agreed: input.agreed, p_allow_small_trunk: input.allowSmallTrunk,
  });
}

/** FC1 (REQ item 231): the actions `freed_car_preview` can try (and roll back) to see whom a freed car would go to. */
export type FreedCarAction =
  | "cancel_ride" | "ride_editor_cancel_ride" | "withdraw_request" | "ride_editor_withdraw_request"
  | "edit_ride" | "submit_request" | "submit_series_request" | "sadran_cancel_ride" | "remove_ride_person"
  | "leave_merged_ride_fit" | "cancel_series_day";

export interface FreedCarPreviewRequest {
  action: FreedCarAction;
  /** Exactly the arguments the real RPC will be sent. */
  args: Record<string, unknown>;
}

/** FC1: the ranking input of every freed-car offer the action would open (the action itself is rolled back). */
export async function previewFreedCar(request: FreedCarPreviewRequest): Promise<unknown[]> {
  const data = (await rpc("freed_car_preview", { p_action: request.action, p_args: request.args as unknown as Json })) as { inputs?: unknown[] } | null;
  return data?.inputs ?? [];
}
