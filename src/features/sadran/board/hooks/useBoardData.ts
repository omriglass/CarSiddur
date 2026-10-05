// Extracted from `BoardScreen.tsx` (docs/TODO.md "Code review 2026-09-24" R9):
// every query the board reads plus the pure derivation of the week-grid
// data (cars/rides/blocks/unmet list/policy preview) that used to live in
// the component's own body. Pure move — behaviour unchanged.
import { formatInTimeZone, fromZonedTime } from "date-fns-tz";
import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";

import { datesOfWeek, todayInJerusalem } from "@/components/dateFieldDates";
import { tv } from "@/i18n/he";
import { TZ, dateKey } from "@/lib/time";
import { ridePublicDetails } from "@/lib/ridePublicDetails";
import { ridePassengerSummary } from "@/lib/ridePassengerSummary";
import { fetchCarSeatConfigs } from "@/features/fleet/api";
import { useDestinations, useRideTypes } from "@/features/fleet/hooks";
import { useCarLocations, useDepartments } from "@/features/siddur/hooks";
import { useRideChanges } from "@/features/rides/hooks";
import { useMyDepartments } from "@/features/auth/useMyDepartments";
import { rideCoordinatorNotes } from "@/lib/rideCoordinatorNotes";
import type { WeekGridBlock, WeekGridCar, WeekGridDiscussionBlock, WeekGridRide } from "@/components/WeekGrid";
import type { Window } from "@/solver";

import { fetchCarMileageTotals, fetchCarStartLocations, fetchFairnessStats, fetchPlaceTravelForWeek } from "../../api";
import { readLastUsedPolicyVersion, rememberLastUsedPolicyVersion } from "../../lastUsedPolicy";
import { sadranKeys } from "../../keys";
import { scanBoardConflicts, slotToIso, requestDayMismatchRideIds, tightScheduleRideIds } from "../geometry";
import { rideBlockLabel } from "../rideLabel";
import { isUnmetStatus } from "../../unmetStatuses";
import { packPhantomLanes, requestStart, requestWindow, standaloneChauffeurWindow } from "../phantomLanes";
import type { BoardDropContext } from "../dropValidity";
import {
  useActivePolicy,
  useAllWeekRides,
  useApplySolverResultMutation,
  useCarsForDepartment,
  useDepartmentSettings,
  useMaintenanceBlocks,
  usePolicyOptions,
  useProposalsForWeek,
  useWeekRequestsWithNames,
  useWeekRow,
} from "../../hooks";
import {
  buildApplyPayload,
  buildSolverContextFromData,
  gatherSolverContext,
  hashSolverInput,
  nowMs,
  policyLookbackWeeks,
  relayPartnerOf,
  representativeRideTypeCode,
  rideStopCount,
  runSolve,
  servedOf,
  withChildNames,
} from "../../solverRun";
import { useBoardPolicyScores } from "../useBoardPolicyScores";
import { useWaitlistGroupsQuery } from "@/features/waitlist/hooks";

import type { SolverContextRows } from "../../solverRun";
import type { Json } from "@/integrations/supabase/types";
import type { SolverOutput } from "@/solver";
import { toast } from "sonner";
import { he } from "@/i18n/he";

/**
 * Board queries plus every pure derivation (week-grid cars/rides/blocks,
 * conflict scan, unmet list, phantom lanes, policy preview/score) that
 * `BoardScreen` used to compute inline. `selectedDay`/`setSelectedDay` also
 * live here since almost everything below is keyed by the selected day.
 */
export function useBoardData(departmentId: string, weekStart: string, focusedConflictRideId: string | undefined) {
  const departmentsQuery = useDepartments();
  const department = (departmentsQuery.data ?? []).find((d) => d.id === departmentId);
  // Mobile title switcher subtitle (UX_FLOWS.md §4.2): the department name only
  // shows there when the Sadran actually manages more than one.
  const myDepartmentsQuery = useMyDepartments();
  const managesMultipleDepartments = (myDepartmentsQuery.data?.length ?? 0) > 1;

  const days = datesOfWeek(weekStart);
  const today = todayInJerusalem();

  const weekRowQuery = useWeekRow(departmentId, weekStart);
  const carsQuery = useCarsForDepartment(departmentId);
  const carLocationsQuery = useCarLocations(departmentId, weekStart);
  const rideTypesQuery = useRideTypes(departmentId);
  const maintenanceQuery = useMaintenanceBlocks(departmentId);
  const requestsQuery = useWeekRequestsWithNames(departmentId, weekStart);
  const ridesQuery = useAllWeekRides(departmentId, weekStart);
  const rideChangesQuery = useRideChanges(departmentId, weekStart);
  const proposalsQuery = useProposalsForWeek(departmentId, weekStart);
  const waitlistGroupsQuery = useWaitlistGroupsQuery(departmentId, weekStart);
  const departmentSettingsQuery = useDepartmentSettings(departmentId);
  const activePolicyQuery = useActivePolicy(departmentId);
  const policyOptionsQuery = usePolicyOptions(departmentId);
  const seatConfigsQuery = useQuery({
    queryKey: sadranKeys.seatConfigs(departmentId),
    queryFn: () => fetchCarSeatConfigs(departmentId),
    enabled: !!departmentId,
    staleTime: 60_000,
  });
  // The solver preview (`computePreview` below) needs destinations too, but
  // the board itself never otherwise reads them — cached here (60s) rather
  // than fetched fresh on every debounced preview run the way
  // `gatherSolverContext`'s fetching wrapper does (docs/HARDENING_2026-09.md
  // §3 item 1).
  const destinationsQuery = useDestinations(departmentId);

  const applySolverResultMutation = useApplySolverResultMutation();
  const [autoSolving, setAutoSolving] = useState(false);

  // No default-selection effect (same render-time-derivation convention as
  // `policyVersionOverride` below): `selectedDayOverride` is only set once
  // the Sadran actually picks a day tab; until then the effective day falls
  // back to today (if it's in this week) or else — bug-fix pass papercut —
  // the day with the most rides/unmet requests, not blindly `days[0]`
  // (Sunday). Defaulting to a day that may have nothing on it at all made a
  // freshly-solved week look exactly like solving had done nothing (owner
  // bug report #4): the board opened on an empty Sunday while every new ride
  // landed on the actual busy days.
  const [selectedDayOverride, setSelectedDayOverride] = useState<string | null>(null);

  function computeDefaultDay(): string {
    if (days.includes(today)) return today;
    const activityByDay = new Map(days.map((d) => [d, 0]));
    for (const r of ridesQuery.data ?? []) {
      if (!r.starts_at) continue;
      const d = dateKey(new Date(r.starts_at));
      if (activityByDay.has(d)) activityByDay.set(d, (activityByDay.get(d) ?? 0) + 1);
    }
    for (const r of requestsQuery.data ?? []) {
      if (!isUnmetStatus(r.status) || !requestStart(r)) continue;
      const d = dateKey(new Date(requestStart(r)!));
      if (activityByDay.has(d)) activityByDay.set(d, (activityByDay.get(d) ?? 0) + 1);
    }
    let best = days[0] ?? weekStart;
    let bestScore = -1;
    for (const d of days) {
      const score = activityByDay.get(d) ?? 0;
      if (score > bestScore) {
        bestScore = score;
        best = d;
      }
    }
    return best;
  }

  const selectedDay = selectedDayOverride ?? computeDefaultDay();
  const setSelectedDay = setSelectedDayOverride;

  // No default-selection effect: an unset override simply falls back to the
  // active policy every render (CLAUDE.md/RequestForm.tsx precedent — this
  // codebase derives such "default until the user picks something" state
  // during render rather than via a `useEffect` + `setState`, per the
  // `react-hooks/set-state-in-effect` lint rule).
  const [policyVersionOverride, setPolicyVersionOverride] = useState<string | null>(readLastUsedPolicyVersion);
  const [preview, setPreview] = useState<{ output: SolverOutput; policyVersionId: string } | null>(null);
  // No loading flag surfaced in the UI anymore: the preview now runs silently
  // in the background (the automatic `useEffect` below), never blocking a
  // button the Sadran clicked.

  // A policy saved on this device is only a default, never an entitlement: if
  // it is not offered by this department, fall back to its active policy.
  const storedPolicyIsAvailable = (policyOptionsQuery.data ?? []).some((policy) => policy.policyVersionId === policyVersionOverride);
  const effectivePolicyVersionId = storedPolicyIsAvailable ? policyVersionOverride : activePolicyQuery.data?.policyVersionId ?? null;
  const effectivePolicyForPreview = (policyOptionsQuery.data ?? []).find((p) => p.policyVersionId === effectivePolicyVersionId)
    ?? activePolicyQuery.data ?? null;
  // Fairness stats also feed the preview only — cached (60s) rather than
  // refetched on every debounced preview run (docs/HARDENING_2026-09.md §3
  // item 1); the lookback window comes from the effective policy's own
  // `fairness` rule params, same as `gatherSolverContext`'s fetching wrapper.
  const fairnessLookbackWeeks = effectivePolicyForPreview ? policyLookbackWeeks(effectivePolicyForPreview) : 3;
  const fairnessStatsQuery = useQuery({
    queryKey: sadranKeys.fairnessStats(departmentId, weekStart, fairnessLookbackWeeks),
    queryFn: () => fetchFairnessStats(departmentId, weekStart, fairnessLookbackWeeks),
    enabled: !!departmentId,
    staleTime: 60_000,
  });
  // F5 (docs/SOLVER.md §3.6.2): rolling-window km per car, also preview-only
  // and cached (60s) like fairness above — the window is a fixed 4 weeks in
  // v1, no policy param to key on (REQUIREMENTS §13.84).
  const mileageStatsQuery = useQuery({
    queryKey: sadranKeys.mileageTotals(departmentId, weekStart),
    queryFn: () => fetchCarMileageTotals(departmentId, weekStart),
    enabled: !!departmentId,
    staleTime: 60_000,
  });
  // REQUIREMENTS §13.93 (ORIGINS_PLAN §2 items 6/7): same preview-only, 60s-cached
  // treatment as mileage above.
  const carStartLocationsQuery = useQuery({
    queryKey: sadranKeys.carStartLocations(departmentId, weekStart),
    queryFn: () => fetchCarStartLocations(departmentId, weekStart),
    enabled: !!departmentId,
    staleTime: 60_000,
  });
  const placeTravelQuery = useQuery({
    queryKey: sadranKeys.placeTravel(departmentId, weekStart),
    queryFn: () => fetchPlaceTravelForWeek(departmentId, weekStart),
    enabled: !!departmentId,
    staleTime: 60_000,
  });

  function selectPolicyVersion(policyVersionId: string) {
    setPolicyVersionOverride(policyVersionId);
  }

  function rememberUsedPolicy(policyVersionId: string) {
    rememberLastUsedPolicyVersion(policyVersionId);
    setPolicyVersionOverride(policyVersionId);
  }

  /**
   * Populates the unmet list's per-request score/suggestions by running the
   * pure solver client-side (SOLVER.md §2), without persisting anything.
   * Previously an explicit "הרץ פותר" click; now run automatically (owner
   * spec 2026-09-10) by the debounced `useEffect` below, whenever the board's
   * own data finishes loading, the effective policy version changes, or a
   * mutation settles — the Sadran no longer has to remember to press it, and
   * the button is gone from the header entirely.
   *
   * The ordinary preview matches remaining-only autofill. Full solving is
   * a separate FullResolveAction with an explicit replacement confirmation.
   */
  function computePreview() {
    const policy = effectivePolicyForPreview;
    if (
      !policy ||
      !department?.home_destination_id ||
      !departmentSettingsQuery.data ||
      destinationsQuery.isLoading ||
      fairnessStatsQuery.isLoading ||
      mileageStatsQuery.isLoading ||
      carStartLocationsQuery.isLoading ||
      placeTravelQuery.isLoading
    ) return;
    try {
      // Reads straight from this screen's own already-loaded query hooks
      // (docs/HARDENING_2026-09.md §3 item 1) instead of `gatherSolverContext`'s
      // fetch-everything wrapper, which every apply path still uses unchanged.
      const context = buildSolverContextFromData(
        {
          departmentId,
          weekStart,
          homeDestinationId: department.home_destination_id,
          policy: {
            policyId: policy.policyId,
            policyVersionId: policy.policyVersionId,
            versionNo: policy.versionNo,
            rules: policy.rules,
            settings: policy.settings,
          },
          mode: "remaining",
        },
        {
          departmentSettings: departmentSettingsQuery.data,
          allRequests: requestsQuery.data ?? [],
          cars: carsQuery.data ?? [],
          destinations: destinationsQuery.data ?? [],
          rideTypes: rideTypesQuery.data ?? [],
          maintenanceBlocks: maintenanceQuery.data ?? [],
          boardRides: ridesQuery.data ?? [],
          seatConfigsFlat: seatConfigsQuery.data ?? [],
          fairness: fairnessStatsQuery.data ?? [],
          mileageKmByCarId: mileageStatsQuery.data ?? {},
          carStartLocationsByCarId: carStartLocationsQuery.data ?? {},
          travel: placeTravelQuery.data ?? [],
        },
      );
      const output = runSolve(context.input);
      rememberUsedPolicy(policy.policyVersionId);
      setPreview({ output, policyVersionId: policy.policyVersionId });
    } catch {
      // Non-blocking: the board still works from persisted request/ride data alone.
    }
  }

  /**
   * "▶ השלם אוטומטית" (UX_FLOWS.md §4.2): pins every current ride (mode
   * `'remaining'`, SOLVER.md §5.1) and solves only the still-open requests,
   * then applies the result directly — unlike the dashboard's "הרץ פותר"
   * flow there is no separate confirmation sheet, since everything already
   * on the board is untouched by definition (only unmet requests can move).
   */
  async function handleAutoSolveRemaining() {
    const chosen = (policyOptionsQuery.data ?? []).find((p) => p.policyVersionId === effectivePolicyVersionId);
    const policy = chosen ?? activePolicyQuery.data;
    if (!policy || !department?.home_destination_id) return;
    setAutoSolving(true);
    try {
      const context = await gatherSolverContext({
        departmentId,
        weekStart,
        homeDestinationId: department.home_destination_id,
        policy: {
          policyId: policy.policyId,
          policyVersionId: policy.policyVersionId,
          versionNo: policy.versionNo,
          rules: policy.rules,
          settings: policy.settings,
        },
        mode: "remaining",
      });
      const startedAtMs = nowMs();
      const output = runSolve(context.input);
      rememberUsedPolicy(policy.policyVersionId);
      const finishedAtMs = nowMs();
      const payload = buildApplyPayload({
        output,
        weekStartMs: context.weekStartMs,
        policyVersionId: context.policyVersionId,
        startedAtMs,
        finishedAtMs,
        inputHash: hashSolverInput(context.input),
        requestsById: context.requestsById,
        // "remaining" mode (owner bug report #5): every ride currently on
        // the board was already passed to the solver as a `fixedRide`
        // constraint, never re-solved — `apply_solver_result` must only add
        // this payload's new rides, never delete anything.
        mode: "remaining",
      });
      const summary = await applySolverResultMutation.mutateAsync({
        departmentId,
        weekStart,
        payload: payload as unknown as Json,
      });
      setPreview({ output, policyVersionId: policy.policyVersionId });
      // Structured summary (bug-fix pass requirement: never a silent
      // partial result) — see `applySolve.ts`'s `ApplySolverResultSummary`.
      toast.success(
        tv("sadranDashboard.appliedSummary", {
          inserted: String(summary.inserted),
          deleted: String(summary.deleted),
          unassigned: String(summary.unassigned_requests.length),
        }),
      );
      if (summary.skippedSeries?.length) {
        toast(tv("sadranBoard.skippedSeries", { count: String(summary.skippedSeries.length) }));
      }
    } catch {
      // toast already shown by the mutation, or silently a no-op if nothing was open
    } finally {
      setAutoSolving(false);
    }
  }

  const policyIsStale = !!preview && preview.policyVersionId !== effectivePolicyVersionId;

  // Live board policy score (owner request, 2026-09-14): the same
  // weighted-coverage / `alignment_ratio` figure `publishWithScores.ts`
  // otherwise only computes at publish time (DATA_MODEL.md §3.9), shown next
  // to the policy chip and per policy row in its dialog. Purely
  // informational — reads the same already-loaded query data `computePreview`
  // above does, one `SolverContextRows` bundle shared by every policy option
  // (`useBoardPolicyScores` builds each policy's own `SolverInput` from it).
  const boardScoreRowsLoading =
    requestsQuery.isLoading ||
    ridesQuery.isLoading ||
    carsQuery.isLoading ||
    rideTypesQuery.isLoading ||
    maintenanceQuery.isLoading ||
    destinationsQuery.isLoading ||
    fairnessStatsQuery.isLoading ||
    mileageStatsQuery.isLoading ||
    carStartLocationsQuery.isLoading ||
    placeTravelQuery.isLoading ||
    seatConfigsQuery.isLoading;
  const boardScoreRows: SolverContextRows | null =
    boardScoreRowsLoading || !departmentSettingsQuery.data
      ? null
      : {
          departmentSettings: departmentSettingsQuery.data,
          allRequests: requestsQuery.data ?? [],
          cars: carsQuery.data ?? [],
          destinations: destinationsQuery.data ?? [],
          rideTypes: rideTypesQuery.data ?? [],
          maintenanceBlocks: maintenanceQuery.data ?? [],
          boardRides: ridesQuery.data ?? [],
          seatConfigsFlat: seatConfigsQuery.data ?? [],
          fairness: fairnessStatsQuery.data ?? [],
          mileageKmByCarId: mileageStatsQuery.data ?? {},
          carStartLocationsByCarId: carStartLocationsQuery.data ?? {},
          travel: placeTravelQuery.data ?? [],
        };
  const boardPolicyScores = useBoardPolicyScores({
    departmentId,
    weekStart,
    homeDestinationId: department?.home_destination_id ?? null,
    policyOptions: policyOptionsQuery.data ?? [],
    rows: boardScoreRows,
  });

  // Automatic solver preview (owner spec 2026-09-10, replaces the removed
  // "הרץ פותר" button): a cheap fingerprint of what the solver actually
  // reads (rides + requests content, not just their loading state, plus the
  // effective policy) so the debounced effect only recomputes when
  // something that could change the preview really changed, never on every
  // render.
  const solverInputFingerprint = [
    effectivePolicyVersionId ?? "",
    (ridesQuery.data ?? []).map((r) => `${r.id}:${r.car_id}:${r.starts_at}:${r.ends_at}:${r.status}:${r.version}`).join(","),
    (requestsQuery.data ?? []).map((r) => `${r.id}:${r.status}:${r.depart_at}:${r.return_at}:${r.version}`).join(","),
  ].join("|");
  useEffect(() => {
    if (
      requestsQuery.isLoading ||
      ridesQuery.isLoading ||
      policyOptionsQuery.isLoading ||
      carsQuery.isLoading ||
      rideTypesQuery.isLoading ||
      maintenanceQuery.isLoading ||
      departmentSettingsQuery.isLoading ||
      destinationsQuery.isLoading ||
      fairnessStatsQuery.isLoading ||
      mileageStatsQuery.isLoading ||
      carStartLocationsQuery.isLoading ||
      placeTravelQuery.isLoading ||
      seatConfigsQuery.isLoading ||
      !effectivePolicyVersionId
    ) return;
    const timer = window.setTimeout(() => { computePreview(); }, 300);
    return () => window.clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `solverInputFingerprint` already captures every input `computePreview` reads.
  }, [
    solverInputFingerprint,
    requestsQuery.isLoading,
    ridesQuery.isLoading,
    policyOptionsQuery.isLoading,
    carsQuery.isLoading,
    rideTypesQuery.isLoading,
    maintenanceQuery.isLoading,
    departmentSettingsQuery.isLoading,
    destinationsQuery.isLoading,
    fairnessStatsQuery.isLoading,
    mileageStatsQuery.isLoading,
    carStartLocationsQuery.isLoading,
    placeTravelQuery.isLoading,
    seatConfigsQuery.isLoading,
    effectivePolicyVersionId,
  ]);

  const daySettings = departmentSettingsQuery.data;
  const rides = ridesQuery.data ?? [];
  const awaitingDriverRequestIds = new Set(rides.filter((ride) => ride.needs_driver).flatMap((ride) => servedOf(ride).map((entry) => entry.request_id)));
  const activeDayRides = rides.filter(
    (r) => r.starts_at && dateKey(new Date(r.starts_at)) === selectedDay,
  );

  const weekStartMs = fromZonedTime(`${weekStart}T00:00:00`, TZ).getTime();

  const conflictScan =
    daySettings && department?.home_destination_id
      ? (() => {
          const validRides = rides.filter(
            (r): r is typeof r & { id: string; car_id: string; starts_at: string; ends_at: string; origin_id: string; destination_id: string } =>
              !!r.id && !!r.car_id && !!r.starts_at && !!r.ends_at && !!r.origin_id && !!r.destination_id,
          );
          const days96 = Array.from({ length: 7 }, (_, i) => ({
            dayIndex: i as 0 | 1 | 2 | 3 | 4 | 5 | 6,
            startSlot: i * 96,
            endSlot: i * 96 + 96,
            dayEndSlot: i * 96 + 95,
          }));
          return scanBoardConflicts({
            rides: validRides.map((r) => ({
              id: r.id,
              carId: r.car_id,
              startsAt: r.starts_at,
              endsAt: r.ends_at,
              originId: r.origin_id,
              destinationId: r.destination_id,
              turnaroundMinutes: r.turnaround_override_minutes ?? undefined,
            })),
            carIds: [...new Set(validRides.map((r) => r.car_id))],
            weekStartMs,
            bufferMinutes: daySettings.turnaround_minutes,
            homeLocationId: department.home_destination_id,
            days: days96,
            // REQUIREMENTS §13.93: each car's own base (`cars.base_location_id`) and its
            // location at week start (`car_start_locations()`) — the away band and the
            // chain-break/week-end-away warnings are relative to these, not always home.
            carLocationsById: new Map(
              (carsQuery.data ?? []).map((c) => [c.id, {
                baseLocationId: c.base_location_id ?? undefined,
                startLocationId: carStartLocationsQuery.data?.[c.id]?.locationId,
              }]),
            ),
          });
        })()
      : null;

  const tightRideIds = tightScheduleRideIds(rides, daySettings?.turnaround_minutes ?? 30);
  const planningRows = (rideChangesQuery.data ?? []).filter((change) => change.is_planning).flatMap((change) => {
    const original = rides.find((ride) => ride.id === change.ride_id);
    return original ? [{ ...original, id: `change:${change.id}`, car_id: change.car_id, starts_at: change.starts_at, ends_at: change.ends_at }] : [];
  });
  const conflictRideIds = new Set([
    ...(conflictScan?.conflictRideIds ?? []),
    ...requestDayMismatchRideIds(rides, requestsQuery.data ?? []),
    ...planningRows.map((ride) => ride.id),
    ...rides.filter((ride) => ride.starts_at && ride.ends_at && (
      dateKey(ride.starts_at) !== dateKey(ride.ends_at)
      || formatInTimeZone(ride.ends_at, TZ, "HH:mm:ss") > "23:59:00"
    )).map((ride) => ride.id as string),
  ]);
  const conflicts = [...rides, ...planningRows].filter((ride): ride is typeof ride & { id: string; starts_at: string; ends_at: string } =>
    !!ride.id && conflictRideIds.has(ride.id) && !!ride.starts_at && !!ride.ends_at)
    .sort((a, b) => Date.parse(a.starts_at) - Date.parse(b.starts_at) || a.id.localeCompare(b.id));
  const focusedConflictIndex = conflicts.findIndex((ride) => ride.id === focusedConflictRideId);
  const focusedConflict = conflicts[focusedConflictIndex];

  const pendingConsentRideIds = new Set(
    (proposalsQuery.data ?? []).filter((p) => p.status === "sent" && p.ride_id).map((p) => p.ride_id as string),
  );

  // REQUIREMENTS §13.93, SOLVER.md §1.3a: a fixed ride whose car isn't actually where the ride
  // claims — a warning only (never a block, never thrown).
  const chainBreakByRideId = new Map<string, { actualLocationId: string }>();
  for (const breaks of (conflictScan?.chainBreaksByCarId ?? new Map()).values()) {
    for (const b of breaks) chainBreakByRideId.set(b.rideId, { actualLocationId: b.actualLocationId });
  }

  function dayStartIso(day: string): string {
    return fromZonedTime(`${day}T00:00:00`, TZ).toISOString();
  }

  // Moved up from near `awayWeekGridBlocks` below — also needed by `weekGridCars`' base badge.
  const destinationNameById = new Map((destinationsQuery.data ?? []).map((d) => [d.id, d.name]));
  const isLastDayOfWeek = selectedDay === days[days.length - 1];
  const weekGridCars: WeekGridCar[] = (carsQuery.data ?? []).map((c) => {
    const base = c.base_location_id ?? undefined;
    const weekEndAway = isLastDayOfWeek ? conflictScan?.weekEndAwayByCarId.get(c.id) : null;
    return {
      id: c.id,
      name: c.name,
      group: c.type,
      locationBadge: carLocationsQuery.data?.find((l) => l.car_id === c.id)?.location_name ?? undefined,
      // REQUIREMENTS §13.93: the car's own base, shown only when it isn't the department home.
      baseBadge: base && base !== department?.home_destination_id
        ? tv("sadranBoard.carBase", { place: destinationNameById.get(base) ?? "" })
        : undefined,
      // REQUIREMENTS §13.93/SOLVER.md §1.3a: a warning only, shown on the last day of the week.
      weekEndAwayWarning: weekEndAway
        ? tv("sadranBoard.carAwayAtWeekEnd", { place: destinationNameById.get(weekEndAway.locationId) ?? "" })
        : undefined,
    };
  });

  // REQ §13.92 "Who": the Sadran may drag-swap car headers on any non-archived day — planning,
  // no notifications (owner A6). An archived week has no board route in practice (its own week
  // switcher excludes it), but a direct URL could still land here, so this still gates the drag.
  const boardCanSwapCars = weekRowQuery.data ? weekRowQuery.data.phase !== "archived" : false;

  const pendingMerges = (proposalsQuery.data ?? []).flatMap((proposal) => {
    if (proposal.type !== "merge" || !["sent", "accepted"].includes(proposal.status)) return [];
    const payload = proposal.payload;
    if (!payload || typeof payload !== "object" || Array.isArray(payload) || typeof payload.starts_at !== "string" || typeof payload.ends_at !== "string") return [];
    const host = rides.find((ride) => ride.id === proposal.ride_id);
    const guest = (requestsQuery.data ?? []).find((request) => request.id === proposal.request_id);
    if (!host?.car_id || !host.id || !guest) return [];
    return [{ proposal, host, guest, startsAt: payload.starts_at, endsAt: payload.ends_at }];
  });
  const shadowedRideIds = new Set((rideChangesQuery.data ?? []).filter((change) => !change.is_planning).flatMap((change) => [change.ride_id, ...change.parties.map((party) => party.ride_id)]));
  for (const merge of pendingMerges) {
    shadowedRideIds.add(merge.host.id!);
    for (const ride of rides) if (ride.id && servedOf(ride).some((entry) => entry.request_id === merge.guest.id)) shadowedRideIds.add(ride.id);
  }
  const weekGridRides: WeekGridRide[] = activeDayRides
    .filter((r) => r.id && r.car_id && r.starts_at && r.ends_at)
    .map((r) => ({
      id: r.id as string,
      carId: r.car_id as string,
      startMinutes: Math.round((Date.parse(r.starts_at as string) - Date.parse(dayStartIso(selectedDay))) / 60_000),
      endMinutes: Math.round((Date.parse(r.ends_at as string) - Date.parse(dayStartIso(selectedDay))) / 60_000),
      requestedStartMinutes: (() => {
        const entry = servedOf(r).find((served) => served.role === "driver") ?? servedOf(r)[0];
        const request = (requestsQuery.data ?? []).find((request) => request.id === entry?.request_id);
        const window = request ? standaloneChauffeurWindow(request, daySettings?.chauffeur_dwell_minutes ?? 10) : null;
        return window ? (Date.parse(window.startsAt) - Date.parse(dayStartIso(selectedDay))) / 60_000 : undefined;
      })(),
      // Owner bug report #3: a round-trip ride is stored as one row with
      // origin_id === destination_id === the department's home location
      // (DATA_MODEL.md consistency decision #14), so `r.destination_name`
      // alone is always the department's own name ("נבו") for the common
      // case — `rideBlockLabel` composes "<driver> ו<passengers> ל<real
      // destination>" from `served` instead (see `rideLabel.ts`).
      description: [servedOf(r).length ? r.notes : null, ridePublicDetails(withChildNames(servedOf(r), requestsQuery.data ?? []), { includeCompanions: false })].filter(Boolean).join("\n"),
      passengerSummary: ridePassengerSummary(withChildNames(servedOf(r), requestsQuery.data ?? []), r.needs_driver ? null : r.driver_name),
      coordinatorNotes: rideCoordinatorNotes(servedOf(r), requestsQuery.data ?? []),
      // REQUIREMENTS §13.93 "Multi-stop rides" Display: "· N עצירות" appended only when the
      // ride actually serves a request with stops (`rideStopCount`, never 0).
      label: (() => {
        const base = (!servedOf(r).length && r.notes) || (
          department?.home_destination_id && r.origin_id && r.destination_id
            ? rideBlockLabel({
                originId: r.origin_id,
                destinationId: r.destination_id,
                originName: r.origin_name ?? "",
                destinationName: r.destination_name ?? "",
                homeDestinationId: department.home_destination_id,
                served: servedOf(r),
                driverName: r.driver_name,
                isChauffeur: !!r.is_chauffeur,
                needsDriver: !!r.needs_driver,
                autoRelocation: !!r.auto_relocation,
                startsAt: r.starts_at ?? undefined,
                relayPartner: relayPartnerOf(r),
              })
            : (r.destination_name ?? ""));
        const stopCount = rideStopCount(servedOf(r));
        return stopCount > 0 ? `${base} ${tv("sadranBoard.stopCount", { count: String(stopCount) })}` : base;
      })(),
      pinned: !!r.is_pinned,
      needsDriver: !!r.needs_driver,
      tightSchedule: tightRideIds.has(r.id as string),
      shadowed: shadowedRideIds.has(r.id as string),
      conflict: conflictRideIds.has(r.id as string),
      highlighted: focusedConflict?.id === r.id,
      pendingConsent: pendingConsentRideIds.has(r.id as string),
      rideTypeCode: representativeRideTypeCode(servedOf(r)),
      seriesIndex: r.series_index,
      seriesCount: r.series_count,
      chainBrokenWarning: r.id && chainBreakByRideId.has(r.id)
        ? tv("sadranBoard.carNotHereWarning", { place: destinationNameById.get(chainBreakByRideId.get(r.id)!.actualLocationId) ?? "" })
        : undefined,
    }));

  for (const merge of pendingMerges) {
    if (dateKey(merge.startsAt) !== selectedDay) continue;
    const host = weekGridRides.find((ride) => ride.id === merge.host.id);
    weekGridRides.push({ id: `merge:${merge.proposal.id}`, carId: merge.host.car_id!,
      startMinutes: (Date.parse(merge.startsAt) - Date.parse(dayStartIso(selectedDay))) / 60_000,
      endMinutes: (Date.parse(merge.endsAt) - Date.parse(dayStartIso(selectedDay))) / 60_000,
      label: `${host?.label ?? merge.host.driver_name ?? ""} · ${merge.guest.requester_full_name ?? ""} · ${merge.guest.destination_resolved_name ?? merge.guest.destination_text ?? ""}`,
      pendingConsent: true, needsDriver: !!merge.host.needs_driver, rideTypeCode: host?.rideTypeCode });
  }

  for (const change of rideChangesQuery.data ?? []) {
    if (dateKey(change.starts_at) !== selectedDay) continue;
    const original = weekGridRides.find((ride) => ride.id === change.ride_id);
    weekGridRides.push({ id: `change:${change.id}`, carId: change.car_id,
      startMinutes: (Date.parse(change.starts_at) - Date.parse(dayStartIso(selectedDay))) / 60_000,
      endMinutes: (Date.parse(change.ends_at) - Date.parse(dayStartIso(selectedDay))) / 60_000,
      label: `${original?.label ?? change.requester?.full_name ?? ""} · ${change.is_planning ? he.boardCoordination.planning : he.rideEditing.pending}`,
      requestedStartMinutes: original?.requestedStartMinutes,
      conflict: change.is_planning, pendingConsent: true, rideTypeCode: original?.rideTypeCode });
  }

  const weekGridBlocks: WeekGridBlock[] = (maintenanceQuery.data ?? []).flatMap((block) => {
    const startMinutes = (Date.parse(block.starts_at) - Date.parse(dayStartIso(selectedDay))) / 60_000;
    const endMinutes = (Date.parse(block.ends_at) - Date.parse(dayStartIso(selectedDay))) / 60_000;
    return startMinutes < 1440 && endMinutes > 0 ? [{ id: block.id, carId: block.car_id, startMinutes, endMinutes, kind: "maintenance" as const }] : [];
  });

  // REQ §89 (owner 2026-09-15)/§13.93: the car is away from its base between a relay out-leg and
  // its return — draw an explicit, non-interactive "away" band instead of leaving that gap
  // looking like a free/vacant column (`conflictScan.awayByCarId`, computed by the same
  // solver `CarTimeline` the conflict scan already reuses). `destinationNameById` is defined
  // above, next to `weekGridCars`' own base badge.
  const awayByCarId: Map<string, { locationId: string; window: Window }[]> = conflictScan?.awayByCarId ?? new Map();
  const awayWeekGridBlocks: WeekGridBlock[] = [...awayByCarId].flatMap(([carId, windows]) =>
    windows.flatMap((away, index) => {
      const startsAt = slotToIso(away.window.start, weekStartMs);
      const endsAt = slotToIso(away.window.end, weekStartMs);
      const startMinutes = (Date.parse(startsAt) - Date.parse(dayStartIso(selectedDay))) / 60_000;
      const endMinutes = (Date.parse(endsAt) - Date.parse(dayStartIso(selectedDay))) / 60_000;
      if (startMinutes >= 1440 || endMinutes <= 0) return [];
      const place = destinationNameById.get(away.locationId) ?? "";
      return [{ id: `away:${carId}:${index}`, carId, startMinutes, endMinutes, kind: "away" as const, label: tv("sadranBoard.awayBand", { place }) }];
    }),
  );

  // Contested waiting-list groups (REQ §13.75, UX_FLOWS.md §4.2): once a day is published, its
  // open groups no longer show as separate `UnmetList` items — they render as one "בדיון" lane
  // block/card, the same as the member siddur.
  const dayWaitlistGroups = (waitlistGroupsQuery.data ?? []).filter((group) => group.day === selectedDay);
  const weekGridDiscussionBlocks: WeekGridDiscussionBlock[] = dayWaitlistGroups.map((group) => ({
    id: group.id,
    startMinutes: Math.round((Date.parse(group.starts_at) - Date.parse(dayStartIso(selectedDay))) / 60_000),
    endMinutes: Math.round((Date.parse(group.ends_at) - Date.parse(dayStartIso(selectedDay))) / 60_000),
    label: tv("waitlist.blockLabel", { names: group.members.map((member) => member.name).join(", ") }),
  }));

  const dayCounts = days.map((d) => ({
    rides: rides.filter((r) => r.starts_at && dateKey(new Date(r.starts_at)) === d).length,
    unmet: (requestsQuery.data ?? []).filter(
      (r) => isUnmetStatus(r.status) && !awaitingDriverRequestIds.has(r.id) && requestStart(r) && dateKey(new Date(requestStart(r)!)) === d,
    ).length,
  }));

  /**
   * Side panel + phone `UnmetList` (UX_FLOWS §4.2): every request of the
   * week with no ride, DB-derived (`isUnmetStatus`) so it's always
   * populated — sorted by solver score when a preview exists, otherwise by
   * departure time (`UnmetList.tsx`'s own sort), never empty just because
   * nobody has clicked "הרץ פותר" yet or the page was reloaded (bug #1).
   */
  const unmetItems = (requestsQuery.data ?? [])
    .filter((r) => isUnmetStatus(r.status) && !awaitingDriverRequestIds.has(r.id) && requestStart(r) && dateKey(new Date(requestStart(r)!)) === selectedDay)
    .map((r) => {
      const solverInfo = preview?.output.unmet.find((u) => u.requestId === r.id);
      return {
        request: r,
        destinationName: r.destination_resolved_name ?? "—",
        solverInfo,
        // REQUIREMENTS §13.93 "Multi-stop rides" §6.3 "Joining at a stop": a merge suggestion
        // whose `boardAtLocationId` is not the host ride's own origin says where the guest
        // boards — parallel array to `solverInfo.suggestions`, `null` for the ordinary
        // same-origin case (nothing worth saying).
        suggestionBoardAt: (solverInfo?.suggestions ?? []).map((suggestion) => {
          if (suggestion.kind !== "merge" || !suggestion.boardAtLocationId) return null;
          const hostOriginId = rides.find((ride) => ride.id === suggestion.hostRideId)?.origin_id;
          if (!hostOriginId || suggestion.boardAtLocationId === hostOriginId) return null;
          return tv("sadranBoard.mergeBoardAt", { place: destinationNameById.get(suggestion.boardAtLocationId) ?? "" });
        }),
      };
    });

  const phantomRides = packPhantomLanes(unmetItems.filter((item) => item.request.status !== "denied").flatMap((item) => {
    const window = requestWindow(item.request);
    if (!window) return [];
    return [{ id: `request:${item.request.id}`, startMinutes: (Date.parse(window.startsAt) - Date.parse(dayStartIso(selectedDay))) / 60_000,
      endMinutes: (Date.parse(window.endsAt) - Date.parse(dayStartIso(selectedDay))) / 60_000,
      label: `${item.request.requester_full_name ?? ""} · ${item.destinationName}`, rideTypeCode: item.request.ride_type_code,
      passengerSummary: ridePassengerSummary([{ ...item.request, requester: item.request.requester_full_name }]) }];
  }));
  for (let lane = 0; lane <= Math.max(-1, ...phantomRides.map((ride) => ride.lane)); lane++) {
    weekGridCars.push({ id: `phantom:${lane}`, name: tv("sadranBoard.phantomCar", { number: String(lane + 1) }), group: "phantom" });
  }
  weekGridCars.push({ id: "phantom:unassign", name: he.sadranBoard.unassignLane, group: "phantom" });
  weekGridRides.push(...phantomRides.map((ride) => ({ ...ride, requestedStartMinutes: ride.startMinutes, carId: `phantom:${ride.lane}`, pendingConsent: true })));

  const seatConfigsByCarId = new Map<string, { adults: number; child_seats: number; boosters: number }[]>();
  for (const sc of seatConfigsQuery.data ?? []) {
    const list = seatConfigsByCarId.get(sc.car_id) ?? [];
    list.push({ adults: sc.adults, child_seats: sc.child_seats, boosters: sc.boosters });
    seatConfigsByCarId.set(sc.car_id, list);
  }

  // Drag/drop validity (docs/REFACTOR_PLAN_2026-09-11.md seam E1(c)): the pure logic
  // (`passengersOf`, `seatsFit`, `unavailable`, `mergeCandidateForRide`, `isDropTargetValid`,
  // `unmetRequestPassengers`, `minutesIso`, `unmetCandidateWindow`, `unmetMergeHost`,
  // `unmetPreviewWindow`, `isUnmetDropValid`) now lives in `../dropValidity.ts`; this is the
  // one place that assembles the closure state those functions need.
  const dropCtx: BoardDropContext = {
    rides,
    requests: requestsQuery.data ?? [],
    cars: carsQuery.data ?? [],
    maintenanceBlocks: maintenanceQuery.data ?? [],
    seatConfigsByCarId,
    unmetItems,
    selectedDay,
    chauffeurDwellMinutes: daySettings?.chauffeur_dwell_minutes ?? 10,
    awayByCarId: conflictScan?.awayByCarId,
    weekStartMs,
    // REQUIREMENTS §13.93: each car's own base, already defaulted to the department home.
    carBaseLocationId: new Map((carsQuery.data ?? []).map((c) => [c.id, c.base_location_id ?? department?.home_destination_id ?? ""])),
    homeDestinationId: department?.home_destination_id ?? undefined,
  };

  return {
    department,
    managesMultipleDepartments,
    days,
    today,
    weekRowQuery,
    carsQuery,
    carLocationsQuery,
    rideTypesQuery,
    maintenanceQuery,
    requestsQuery,
    ridesQuery,
    rideChangesQuery,
    proposalsQuery,
    waitlistGroupsQuery,
    departmentSettingsQuery,
    activePolicyQuery,
    policyOptionsQuery,
    seatConfigsQuery,
    destinationsQuery,
    applySolverResultMutation,
    autoSolving,
    selectedDay,
    setSelectedDay,
    policyVersionOverride,
    preview,
    selectPolicyVersion,
    rememberUsedPolicy,
    effectivePolicyVersionId,
    handleAutoSolveRemaining,
    policyIsStale,
    boardPolicyScores,
    rides,
    activeDayRides,
    weekStartMs,
    conflictScan,
    tightRideIds,
    planningRows,
    conflictRideIds,
    conflicts,
    pendingConsentRideIds,
    dayStartIso,
    weekGridCars,
    boardCanSwapCars,
    pendingMerges,
    shadowedRideIds,
    weekGridRides,
    weekGridBlocks,
    awayByCarId,
    awayWeekGridBlocks,
    dayWaitlistGroups,
    weekGridDiscussionBlocks,
    dayCounts,
    unmetItems,
    seatConfigsByCarId,
    dropCtx,
    focusedConflict,
    focusedConflictIndex,
  };
}
