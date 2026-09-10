import { useActiveDepartment } from "@/features/auth/useActiveDepartment";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { roundUpToQuarterHour } from "@/features/siddur/freeWindows";
import { siddurKeys } from "@/features/siddur/queryKeys";
import { useDayFreeWindows, type DayFreeWindowsAway, type DayFreeWindowsCar } from "@/features/siddur/useDayFreeWindows";
import { sadranKeys } from "@/features/sadran/keys";
import { useSession } from "@/features/auth/useSession";
import { showErrorToast } from "@/lib/rpc";
import { dateKey, weekStartFor } from "@/lib/time";

import type { CarFreeWindow } from "@/features/siddur/freeWindows";

import {
  cancelRide,
  claimFreedSlot,
  fetchMyFreedSlotOffers,
  fetchMyRequests,
  fetchRequestById,
  fetchRequestCompanionIds,
  fetchRequestChildIds,
  fetchTemplateSuggestions,
  saveRequestTemplate,
  setFreedSlotOptOut,
  setRequestCompanions,
  setRequestChildren,
  snoozeRequestTemplate,
  stopRequestTemplate,
  submitRequest,
  withdrawFreedSlotClaim,
  withdrawRequest,
  withdrawAllRequests,
  type SubmitRequestPayload,
} from "./api";
import { requestsKeys } from "./queryKeys";

export function useMyRequests() {
  const { departmentId } = useActiveDepartment();
  const { session } = useSession();
  const profileId = session?.user.id;

  return useQuery({
    queryKey: [...requestsKeys.mine(profileId), departmentId],
    queryFn: () => fetchMyRequests(profileId as string, departmentId),
    enabled: !!profileId && !!departmentId,
    staleTime: 30_000,
  });
}

export function useSubmitRequestMutation() {
  const { session } = useSession();
  const profileId = session?.user.id;
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (payload: SubmitRequestPayload) => submitRequest(payload),
    onSuccess: (_result, payload) => {
      queryClient.invalidateQueries({ queryKey: requestsKeys.mine(profileId) });
      queryClient.invalidateQueries({ queryKey: siddurKeys.myUpcomingRides(undefined, undefined).slice(0, 2) });
      if (payload.request_id) queryClient.invalidateQueries({ queryKey: requestsKeys.byId(payload.request_id) });
      queryClient.invalidateQueries({ queryKey: sadranKeys.week(payload.department_id, payload.week_start) });
      queryClient.invalidateQueries({ queryKey: siddurKeys.boardRides(payload.department_id, payload.week_start) });
      queryClient.invalidateQueries({ queryKey: siddurKeys.carLocations(payload.department_id, payload.week_start) });
    },
    onError: showErrorToast,
  });
}

export function useWithdrawRequestMutation() {
  const { session } = useSession();
  const profileId = session?.user.id;
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({ requestId, expectedVersion }: { requestId: string; expectedVersion: number }) =>
      withdrawRequest(requestId, expectedVersion),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: requestsKeys.mine(profileId) });
      queryClient.invalidateQueries({ queryKey: siddurKeys.all });
      queryClient.invalidateQueries({ queryKey: sadranKeys.all });
    },
    onError: showErrorToast,
  });
}

export function useCancelRideMutation() {
  const { session } = useSession();
  const profileId = session?.user.id;
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({
      rideId,
      reason,
      expectedVersion,
    }: {
      rideId: string;
      reason: string;
      expectedVersion?: number;
    }) => cancelRide(rideId, reason, expectedVersion),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: requestsKeys.mine(profileId) });
      queryClient.invalidateQueries({ queryKey: siddurKeys.all });
      queryClient.invalidateQueries({ queryKey: sadranKeys.all });
    },
    onError: showErrorToast,
  });
}

/** A single request for the edit form (`/requests/:id/edit`). */
export function useRequestQuery(requestId: string | undefined) {
  const { session } = useSession();
  const profileId = session?.user.id;
  return useQuery({
    queryKey: [...requestsKeys.byId(requestId), profileId],
    queryFn: () => fetchRequestById(requestId as string, profileId as string),
    enabled: !!requestId && !!profileId,
  });
}

export function useRequestCompanionsQuery(requestId: string | undefined) {
  return useQuery({
    queryKey: requestsKeys.companions(requestId),
    queryFn: () => fetchRequestCompanionIds(requestId as string),
    enabled: !!requestId,
  });
}

export function useRequestChildrenQuery(requestId: string | undefined) {
  return useQuery({
    queryKey: [...requestsKeys.companions(requestId), "children"],
    queryFn: () => fetchRequestChildIds(requestId as string),
    enabled: !!requestId,
  });
}

export function useSetRequestCompanionsMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ requestId, profileIds }: { requestId: string; profileIds: string[] }) =>
      setRequestCompanions(requestId, profileIds),
    onSuccess: () => {
      for (const key of [siddurKeys.all, sadranKeys.all, requestsKeys.all]) void queryClient.invalidateQueries({ queryKey: key });
    },
    onError: showErrorToast,
  });
}

export function useSetRequestChildrenMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ requestId, childIds }: { requestId: string; childIds: string[] }) => setRequestChildren(requestId, childIds),
    onSuccess: () => { void queryClient.invalidateQueries({ queryKey: requestsKeys.all }); },
    onError: showErrorToast,
  });
}

/** Freed-slot offers addressed to me (My requests list — "אני עדיין רוצה"). */
export function useMyFreedSlotOffers() {
  const { session } = useSession();
  const profileId = session?.user.id;

  return useQuery({
    queryKey: requestsKeys.freedOffers(profileId),
    queryFn: () => fetchMyFreedSlotOffers(profileId as string),
    enabled: !!profileId,
    staleTime: 15_000,
  });
}

export function useClaimFreedSlotMutation() {
  const { session } = useSession();
  const profileId = session?.user.id;
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({ offerId, requestId }: { offerId: string; requestId: string }) =>
      claimFreedSlot(offerId, requestId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: requestsKeys.freedOffers(profileId) });
      queryClient.invalidateQueries({ queryKey: requestsKeys.mine(profileId) });
    },
    onError: showErrorToast,
  });
}

/** Owner (or Sadran) toggles "don't offer me freed slots" on an existing request. */
export function useSetFreedSlotOptOutMutation() {
  const { session } = useSession();
  const profileId = session?.user.id;
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({ requestId, optOut }: { requestId: string; optOut: boolean }) =>
      setFreedSlotOptOut(requestId, optOut),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: requestsKeys.mine(profileId) });
    },
    onError: showErrorToast,
  });
}

export function useWithdrawFreedSlotClaimMutation() {
  const { session } = useSession();
  const profileId = session?.user.id;
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({ offerId, requestId }: { offerId: string; requestId: string }) =>
      withdrawFreedSlotClaim(offerId, requestId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: requestsKeys.freedOffers(profileId) });
    },
    onError: showErrorToast,
  });
}

export interface FreeCarsNowResult {
  isLoading: boolean;
  /** Today's `week_start` (Asia/Jerusalem) — the car-now flow is always about today's week. */
  weekStart: string;
  /** Today, `yyyy-MM-dd` (Asia/Jerusalem). */
  day: string;
  now: Date;
  /** Every shared car in the department (`QuickRequestSheet`'s `cars` prop, for its picker). */
  cars: DayFreeWindowsCar[];
  /** The subset of `cars` free to take right now (rounded up to the next 15 minutes). */
  freeCars: DayFreeWindowsCar[];
  freeWindows: CarFreeWindow[];
  awayWindows: DayFreeWindowsAway[];
}

/**
 * `CarNowButton` (Home §3.3, UX_FLOWS.md §18): is a shared car free *right now*, in this
 * department, today? Built on the same free-window pipeline the quick-request-from-slot flow
 * uses (`features/siddur/useDayFreeWindows.ts`) rather than a new query, scoped to today's
 * `week_start` (`weekStartFor`, CLAUDE.md hard rule 6) instead of a day/week the caller picks —
 * the car-now flow is never about a selected day.
 */
export function useFreeCarsNowQuery(departmentId: string | undefined): FreeCarsNowResult {
  const now = new Date();
  const day = dateKey(now);
  const weekStart = dateKey(weekStartFor(now));
  const dayFreeWindows = useDayFreeWindows(departmentId, weekStart, day, now);
  const nowRounded = roundUpToQuarterHour(now.getTime());
  const freeCars = dayFreeWindows.cars.filter((car) =>
    dayFreeWindows.freeWindows.some((w) => w.carId === car.id && w.start === nowRounded),
  );

  return {
    isLoading: dayFreeWindows.isLoading,
    weekStart,
    day,
    now,
    cars: dayFreeWindows.cars,
    freeCars,
    freeWindows: dayFreeWindows.freeWindows,
    awayWindows: dayFreeWindows.awayWindows,
  };
}

/** Repeating-request suggestions for an `open` week (Home + `/requests/new`, REQ §76). */
export function useTemplateSuggestionsQuery() {
  const { session } = useSession();
  const profileId = session?.user.id;

  return useQuery({
    queryKey: requestsKeys.templateSuggestions(profileId),
    queryFn: fetchTemplateSuggestions,
    enabled: !!profileId,
    staleTime: 30_000,
  });
}

export function useSaveRequestTemplateMutation() {
  const { session } = useSession();
  const profileId = session?.user.id;
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (requestId: string) => saveRequestTemplate(requestId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: requestsKeys.templateSuggestions(profileId) });
      queryClient.invalidateQueries({ queryKey: requestsKeys.mine(profileId) });
    },
    onError: showErrorToast,
  });
}

export function useSnoozeTemplateMutation() {
  const { session } = useSession();
  const profileId = session?.user.id;
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({ templateId, weekStart }: { templateId: string; weekStart: string }) =>
      snoozeRequestTemplate(templateId, weekStart),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: requestsKeys.templateSuggestions(profileId) });
    },
    onError: showErrorToast,
  });
}

export function useStopTemplateMutation() {
  const { session } = useSession();
  const profileId = session?.user.id;
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (templateId: string) => stopRequestTemplate(templateId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: requestsKeys.templateSuggestions(profileId) });
      queryClient.invalidateQueries({ queryKey: requestsKeys.mine(profileId) });
    },
    onError: showErrorToast,
  });
}

export function useWithdrawAllRequestsMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ departmentId, weekStart }: { departmentId: string; weekStart: string }) =>
      withdrawAllRequests(departmentId, weekStart),
    onSuccess: (_result, { departmentId, weekStart }) => {
      void queryClient.invalidateQueries({ queryKey: requestsKeys.all });
      void queryClient.invalidateQueries({ queryKey: siddurKeys.myUpcomingRides(undefined, undefined).slice(0, 2) });
      void queryClient.invalidateQueries({ queryKey: sadranKeys.week(departmentId, weekStart) });
      void queryClient.invalidateQueries({ queryKey: siddurKeys.boardRides(departmentId, weekStart) });
      void queryClient.invalidateQueries({ queryKey: siddurKeys.carLocations(departmentId, weekStart) });
    },
    onError: showErrorToast,
  });
}
