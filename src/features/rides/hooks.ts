import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { useSession } from "@/features/auth/useSession";
import { inboxKeys } from "@/features/inbox/queryKeys";
import { requestsKeys } from "@/features/requests/queryKeys";
import { sadranKeys } from "@/features/sadran/keys";
import { siddurKeys } from "@/features/siddur/queryKeys";
import { showErrorToast } from "@/lib/rpc";

import {
  addRidePassengers,
  cancelRideChange,
  claimRideDriver,
  joinOtherRide,
  fetchCarNeighbours,
  fetchRideChanges,
  handOverOwnRide,
  removeRidePerson,
  requestRideChange,
  respondRideChange,
  updateRidePublicNotes,
  type RideMove,
  type RidePassengerInput,
} from "./api";
import { mapCarNeighbours, type CarNeighbours } from "./carHandover";
import { ridesKeys } from "./keys";
import { invalidateWeekData } from "./invalidateWeek";

/**
 * `departmentId`/`weekStart` on the input are unused by `updateRidePublicNotes` itself — both
 * callers (siddur `RideDetailSheet`, board `RideSheet`) already have the ride's own
 * `department_id`/`week_start`, so passing them through only scopes the invalidation.
 */
export function useUpdateRidePublicNotesMutation() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (vars: { rideId: string; expectedVersion: number; notes: string | null; departmentId: string; weekStart: string }) =>
      updateRidePublicNotes(vars.rideId, vars.expectedVersion, vars.notes),
    onSuccess: (_data, { departmentId, weekStart }) => {
      void invalidateWeekData(client, departmentId, weekStart);
    },
    onError: showErrorToast,
  });
}

/**
 * The "+ נוסעים" button — appends named passengers to a published ride (siddur
 * `RideDetailSheet`, board `RideSheet`, and `RequestForm`'s "join now" flow). `departmentId`/
 * `weekStart` are optional: the two ride-sheet callers pass the ride's own values and get a
 * scoped invalidation; `RequestForm`'s join-now flow doesn't carry them at that call site, so it
 * falls back to the pre-R7 broad invalidation rather than risk missing something.
 */
export function useAddRidePassengersMutation() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (vars: { rideId: string; expectedVersion: number; passengers: RidePassengerInput[]; departmentId?: string; weekStart?: string }) =>
      addRidePassengers(vars.rideId, vars.expectedVersion, vars.passengers),
    onSuccess: (_data, { departmentId, weekStart }) => {
      if (departmentId && weekStart) {
        void invalidateWeekData(client, departmentId, weekStart);
      } else {
        for (const key of [siddurKeys.all, sadranKeys.all, requestsKeys.all]) void client.invalidateQueries({ queryKey: key });
      }
    },
    onError: showErrorToast,
  });
}

export function useRemoveRidePassengerMutation() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({ rideId, expectedVersion, key }: {
      rideId: string; expectedVersion: number; key: string; departmentId: string; weekStart: string;
    }) => removeRidePerson(rideId, expectedVersion, key),
    onSuccess: (_data, { departmentId, weekStart }) => {
      void invalidateWeekData(client, departmentId, weekStart);
    },
    onError: showErrorToast,
  });
}

/** REQ §13.129 (b): "remove me — <name> drives". */
export function useHandOverOwnRideMutation() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({ rideId, expectedVersion, newDriver }: { rideId: string; expectedVersion: number; newDriver: string; departmentId: string; weekStart: string }) =>
      handOverOwnRide(rideId, expectedVersion, newDriver),
    onSuccess: (_data, { departmentId, weekStart }) => {
      void invalidateWeekData(client, departmentId, weekStart);
    },
    onError: showErrorToast,
  });
}

export function useClaimRideDriverMutation() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({ rideId, expectedVersion }: { rideId: string; expectedVersion: number }) => claimRideDriver(rideId, expectedVersion),
    onSuccess: () => {
      for (const key of [siddurKeys.all, sadranKeys.all, requestsKeys.all, inboxKeys.all])
        void client.invalidateQueries({ queryKey: key });
    },
    onError: showErrorToast,
  });
}

export function useJoinOtherRideMutation() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({ requestId, rideId, expectedVersion }: { requestId: string; rideId: string; expectedVersion: number }) =>
      joinOtherRide(requestId, rideId, expectedVersion),
    onSuccess: () => {
      for (const key of [siddurKeys.all, sadranKeys.all, requestsKeys.all, inboxKeys.all])
        void client.invalidateQueries({ queryKey: key });
    },
    onError: showErrorToast,
  });
}

/** Pending ride-change polling interval; ride changes also refresh through every ride/request mutation. */
export const RIDE_CHANGES_POLL_MS = 60_000;

interface RideChangesOptions {
  /** A week-scoped screen: wait for both ids instead of first fetching every department/week (the cold double fetch). */
  scoped?: boolean;
  /** Poll/fetch only while the result is shown or acted on (e.g. a ride sheet is open). */
  enabled?: boolean;
}

export function useRideChanges(departmentId?: string, weekStart?: string, options: RideChangesOptions = {}) {
  const { session } = useSession();
  const ready = !options.scoped || (!!departmentId && !!weekStart);
  return useQuery({
    queryKey: ridesKeys.rideChanges(session?.user.id, departmentId, weekStart),
    queryFn: () => fetchRideChanges(departmentId, weekStart),
    enabled: !!session && ready && (options.enabled ?? true),
    refetchInterval: RIDE_CHANGES_POLL_MS,
  });
}

/** `departmentId`/`weekStart` scope the invalidation only — `requestRideChange` itself only needs the `RideMove` fields. */
export function useRequestRideChangeMutation() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (move: RideMove & { departmentId: string; weekStart: string }) => requestRideChange(move),
    onSuccess: (_data, { departmentId, weekStart }) => {
      void invalidateWeekData(client, departmentId, weekStart);
    },
    onError: showErrorToast,
  });
}

export function useRespondRideChangeMutation() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({ changeId, accept }: { changeId: string; accept: boolean }) => respondRideChange(changeId, accept),
    onSuccess: () => {
      for (const key of [siddurKeys.all, sadranKeys.all, requestsKeys.all, inboxKeys.all])
        void client.invalidateQueries({ queryKey: key });
    },
    onError: showErrorToast,
  });
}

export function useCancelRideChangeMutation() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: cancelRideChange,
    onSuccess: () => {
      for (const key of [siddurKeys.all, sadranKeys.all, inboxKeys.all]) void client.invalidateQueries({ queryKey: key });
    },
    onError: showErrorToast,
  });
}

/** Neighbours (ride before/after on the same car) for the given rides, keyed by ride id. Nothing is fetched for no ids. */
export function useCarNeighboursQuery(rideIds: readonly string[]) {
  const ids = [...new Set(rideIds)];
  return useQuery({
    queryKey: ridesKeys.carNeighbours(ids),
    queryFn: () => fetchCarNeighbours(ids),
    enabled: ids.length > 0,
    select: (rows): Map<string, CarNeighbours> => {
      const byRide = new Map<string, CarNeighbours>();
      for (const row of rows) if (row.ride_id) byRide.set(row.ride_id, mapCarNeighbours(row));
      return byRide;
    },
  });
}
