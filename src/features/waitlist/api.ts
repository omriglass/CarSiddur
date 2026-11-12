import { fetchWeekPart } from "@/features/rides/api";
import { rpc } from "@/lib/rpc";

import { placeWaitingResultSchema, waitingRequestSchema, waitlistGroupHoldSchema, waitlistGroupRowSchema } from "./schema";
import type { PlaceWaitingResult, WaitingRequest, WaitlistGroup, WaitlistGroupHold } from "./types";

/**
 * Contested waiting-list groups (REQ §13.75, DATA_MODEL.md §7.4a). This is
 * the only file in the `waitlist` feature that calls `supabase.from()`/
 * `.rpc()` (CLAUDE.md "Structure").
 */
export async function fetchWaitlistGroups(departmentId: string, weekStart: string): Promise<WaitlistGroup[]> {
  const data = await fetchWeekPart<unknown[]>(departmentId, weekStart, "waitlistGroups");
  return data.map((row) => waitlistGroupRowSchema.parse(row));
}

export interface ResolveWaitlistGroupResult {
  group_id: string;
  ride_id: string;
  car_id: string;
  driver_request_id: string;
  chosen: string[];
  not_chosen: string[];
}

/** `p_request_ids[0]` is the driver (DATA_MODEL.md §7.4a). */
export async function resolveWaitlistGroup(groupId: string, requestIds: string[], expectedVersion: number): Promise<ResolveWaitlistGroupResult> {
  const result = await rpc("resolve_waitlist_group", {
    p_group_id: groupId,
    p_request_ids: requestIds,
    p_expected_version: expectedVersion,
  });
  return result as unknown as ResolveWaitlistGroupResult;
}

/** Sadran-only: drops the group, every member stays `waitlisted`/`WAITLISTED_NO_CAR`. */
export async function cancelWaitlistGroup(groupId: string, expectedVersion: number): Promise<void> {
  await rpc("cancel_waitlist_group", { p_group_id: groupId, p_expected_version: expectedVersion });
}

/** REQ §13.157: the member (or the Sadran) adds a waitlisted request to the open discussion it overlaps. */
export async function joinWaitlistDiscussion(requestId: string): Promise<{ group_id: string }> {
  const result = await rpc("join_waitlist_discussion", { p_request_id: requestId });
  return result as unknown as { group_id: string };
}

/** REQ §13.157: per open group, the cars it holds and each car's free gap around it. */
export async function fetchWaitlistGroupHolds(departmentId: string, weekStart: string): Promise<WaitlistGroupHold[]> {
  const data = await fetchWeekPart<unknown[]>(departmentId, weekStart, "waitlistHolds");
  return data.map((row) => waitlistGroupHoldSchema.parse(row));
}

/** REQ §13.182: the week's requests waiting for a car on published days (the siddur's "חסר רכב" columns). */
export async function fetchSiddurWaitlist(departmentId: string, weekStart: string): Promise<WaitingRequest[]> {
  const data = await fetchWeekPart<unknown[]>(departmentId, weekStart, "siddurWaitlist");
  return data.map((row) => waitingRequestSchema.parse(row));
}

/** REQ §13.183: a waiting round trip dragged onto a car at new hours; `accept` = the warnings the member confirmed. */
export async function placeWaitingRequest(input: {
  requestId: string; carId: string; departAt: string; returnAt: string; expectedVersion: number; accept: string[];
}): Promise<PlaceWaitingResult> {
  const result = await rpc("place_waiting_request", {
    p_request_id: input.requestId, p_car_id: input.carId, p_depart_at: input.departAt, p_return_at: input.returnAt,
    p_expected_version: input.expectedVersion, p_accept: input.accept,
  });
  return placeWaitingResultSchema.parse(result);
}
