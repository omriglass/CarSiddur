// Extracted from `BoardScreen.tsx` (docs/TODO.md "Code review 2026-09-24" R9):
// every query the board reads plus the pure derivation of the week-grid
// data (cars/rides/blocks/unmet list/policy preview) that used to live in
// the component's own body. Pure move — behaviour unchanged.
import { withoutPrivateCarOffers } from "../privateCarOffers";
import { formatInTimeZone, fromZonedTime } from "date-fns-tz";
import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";

import { datesOfWeek, todayInJerusalem } from "@/components/dateFieldDates";
import { tv } from "@/i18n/he";
import { luggageMarker } from "@/lib/luggageWaiver";
import { TZ, dateKey, formatTime } from "@/lib/time";
import { ridePublicDetails } from "@/lib/ridePublicDetails";
import { ridePassengerSummary } from "@/lib/ridePassengerSummary";
import { fetchCarSeatConfigs } from "@/features/fleet/api";
import { useDestinations, useRideTypes } from "@/features/fleet/hooks";
import { useCarLocations, useDepartments } from "@/features/siddur/hooks";
import { useRideChanges } from "@/features/rides/hooks";
import { isReservation } from "@/features/rides/servedOf";
import { useMyDepartments } from "@/features/auth/useMyDepartments";
import { useProfile } from "@/features/auth/useProfile";
import { rideCoordinatorNotes } from "@/lib/rideCoordinatorNotes";
import type { WeekGridBlock, WeekGridCar, WeekGridDiscussionBlock, WeekGridRide } from "@/components/WeekGrid";
import type { Window } from "@/solver";

import { fetchCarMileageTotals, fetchCarStartLocations, fetchFairnessStats, fetchPlaceTravelForWeek } from "../../api";
import { readLastUsedPolicyVersion, rememberLastUsedPolicyVersion } from "../../lastUsedPolicy";
import { sadranKeys } from "../../keys";
import { scanBoardConflicts, slotToIso, requestDayMismatchRideIds, tightScheduleRideIds } from "../geometry";
import { rideBlockLabel } from "../rideLabel";
import { DEFAULT_STOP_MINUTES, homeTravelEdges, makeHop, makeHopKm, parseRideRoute } from "@/lib/rideRoute";
import { viaLabel } from "@/lib/routeLabel";
import { effectiveWeekSettings } from "@/lib/weekSettings";
import { addedGuestsOf, mergePayloadLeg, previewMerge } from "../mergeProposal";
import { connectedPairRideIds, unmetItemId, unmetRequestViews, viewsOnDay } from "../unmetLegs";
import { isUnmetStatus } from "../../unmetStatuses";
import { requestRouteLine, tripTypeLabel } from "../requestRoute";
import { resolveDraftPlacements } from "../draftOverlay";
import { awayLocationAt } from "../geometry";
import { packPhantomLanes, requestStart, requestWindow, standaloneChauffeurWindow, withRouteTravelMinutes } from "../phantomLanes";
import type { BoardDropContext } from "../dropValidity";
import {
  useActivePolicy,
  useAllWeekRides,
  useApplySolverResultMutation,
  useCarsForDepartment,
  useDepartmentSettings,
  useMaintenanceBlocks,
  useMergePreviews,
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
  restrictInputToDay,
  rideViaNames,
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
  // REQ item 108 c: an admin may place over a maintenance block (SQL `rides_before_write`), so the drop checks let them.
  const profileData = useProfile().data;
  const isAdmin = !!profileData?.is_admin;
  const myProfileId = profileData?.id ?? null;
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
  // R3B15: the picked day outlives the board's own unmounting (the composer is a separate route), so
  // the day is also kept per department+week in sessionStorage and restored on mount.
  const dayStorageKey = `board-day:${departmentId}:${weekStart}`;
  const [selectedDayOverride, setSelectedDayOverrideState] = useState<string | null>(() => readStoredBoardDay(dayStorageKey));
  const setSelectedDayOverride = (day: string | null) => {
    setSelectedDayOverrideState(day);
    writeStoredBoardDay(dayStorageKey, day);
  };

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

  // QU3: the computed default is latched once the week's data is in, so a later change in
  // activity (a proposal sent, a drop) never moves the board off the day being worked on.
  const [latchedDay, setLatchedDay] = useState<string | null>(null);
  const defaultDay = computeDefaultDay();
  const validLatchedDay = latchedDay && days.includes(latchedDay) ? latchedDay : null;
  if (!(selectedDayOverride && days.includes(selectedDayOverride)) && !validLatchedDay && ridesQuery.data && requestsQuery.data && days.length > 0) {
    setLatchedDay(defaultDay);
    writeStoredBoardDay(dayStorageKey, defaultDay);
  }
  const selectedDay = selectedDayOverride && days.includes(selectedDayOverride) ? selectedDayOverride : validLatchedDay ?? defaultDay;
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
          proposals: proposalsQuery.data ?? [],
          weekRow: weekRowQuery.data,
        },
      );
      const output = withoutPrivateCarOffers(runSolve(context.input), carsQuery.data ?? [], ridesQuery.data ?? [], requestsQuery.data ?? []);
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
  async function handleAutoSolveRemaining(day: string | null = null) {
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
      if (day) restrictInputToDay(context.input, day);
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
          weekRow: weekRowQuery.data,
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
    JSON.stringify(weekRowQuery.data?.settings_overrides ?? null),
    (ridesQuery.data ?? []).map((r) => `${r.id}:${r.car_id}:${r.starts_at}:${r.ends_at}:${r.status}:${r.version}`).join(","),
    (requestsQuery.data ?? []).map((r) => `${r.id}:${r.status}:${r.depart_at}:${r.return_at}:${r.version}`).join(","),
    // REQ §13.94: a draft/sent/accepted proposal removes its request from solving and fixes its window.
    (proposalsQuery.data ?? []).map((p) => `${p.id}:${p.status}:${JSON.stringify(p.payload)}`).join(","),
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
      weekRowQuery.isLoading ||
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
    weekRowQuery.isLoading,
    destinationsQuery.isLoading,
    fairnessStatsQuery.isLoading,
    mileageStatsQuery.isLoading,
    carStartLocationsQuery.isLoading,
    placeTravelQuery.isLoading,
    seatConfigsQuery.isLoading,
    effectivePolicyVersionId,
  ]);

  const daySettings = departmentSettingsQuery.data;
  // REQ §13.108 D1: the week's override of turnaround / chauffeur dwell, same source as SQL `required_turnaround_minutes()`.
  const weekSettings = effectiveWeekSettings(daySettings, weekRowQuery.data);
  const rides = ridesQuery.data ?? [];
  const awaitingDriverRequestIds = new Set(rides.filter((ride) => ride.needs_driver).flatMap((ride) => servedOf(ride).map((entry) => entry.request_id)));

  // REQ §13.94: route data for the merged-ride twin (`src/lib/rideRoute.ts`) and for the one-way
  // placement window (route minutes from the request's own origin, not the home-based
  // `destination_travel_minutes`). `boardRequests` are display/placement copies; the solver and
  // proposal payloads keep reading `requestsQuery.data`.
  const stopMinutes = departmentSettingsQuery.data?.stop_minutes ?? DEFAULT_STOP_MINUTES;
  const placeTravelData = placeTravelQuery.data;
  const homeId = department?.home_destination_id ?? undefined;
  const destinationRows = destinationsQuery.data;
  const travelEdges = useMemo(() => [...(placeTravelData ?? []), ...homeTravelEdges(homeId, destinationRows ?? [])], [placeTravelData, homeId, destinationRows]);
  const hop = useMemo(() => makeHop(travelEdges), [travelEdges]);
  const hopKm = useMemo(() => makeHopKm(travelEdges), [travelEdges]);
  const detourLimitMinutes = departmentSettingsQuery.data?.detour_limit_minutes;
  const detourLimitKm = departmentSettingsQuery.data?.detour_limit_km;
  const routeCtx = useMemo(() => ({ hop, hopKm, stopMinutes, homeId, detourLimitMinutes, detourLimitKm }), [hop, hopKm, stopMinutes, homeId, detourLimitMinutes, detourLimitKm]);
  const requestRows = requestsQuery.data;
  const boardRequests = useMemo(() => withRouteTravelMinutes(requestRows ?? [], routeCtx), [requestRows, routeCtx]);

  /** Open (submitted/waitlisted) requests anchored on `day` (null = whole week) — the autofill confirmation count. */
  function openRequestCount(day: string | null): number {
    return boardRequests.filter((r) => {
      if (r.status !== "submitted" && r.status !== "waitlisted") return false;
      if (!day) return true;
      const start = requestStart(r);
      return !!start && dateKey(new Date(start)) === day;
    }).length;
  }

  // Board drafts (REQ §13.94): every unsent proposal drawn as the result it would produce. A draft
  // that places its request on a car (shift/merge/origin) takes the request off the unmet list
  // ("planned, tentatively") and, for a shift of an already-placed request, hides the original
  // ride block while the draft block shows. Drafts that place nothing (deny/external, a shift
  // with no car) leave the request visible in the unmet list.
  // REQ item 108 (M1): every open (draft/sent/accepted) merge's window comes from the server's `merge_preview`;
  // the route twin only shows while a preview loads or when it fails (or when the server says the merge no longer holds).
  const openMergeSpecs = (proposalsQuery.data ?? []).flatMap((proposal) => {
    if (proposal.type !== "merge" || !["draft", "sent", "accepted"].includes(proposal.status)) return [];
    const mergeHost = rides.find((ride) => ride.id === proposal.ride_id);
    const mergeGuest = boardRequests.find((request) => request.id === proposal.request_id);
    return mergeHost?.id && mergeGuest ? [{ proposalId: proposal.id, rideId: mergeHost.id, requestId: mergeGuest.id, leg: mergePayloadLeg(proposal.payload, mergeGuest) }] : [];
  });
  const openMergeQueries = useMergePreviews(openMergeSpecs, true, 15_000);
  const serverMergeWindows = new Map<string, { startsAt: string; endsAt: string }>();
  openMergeSpecs.forEach((spec, index) => {
    const server = openMergeQueries[index]?.data;
    if (server?.ok && server.newStartsAt && server.newEndsAt) serverMergeWindows.set(spec.proposalId, { startsAt: server.newStartsAt, endsAt: server.newEndsAt });
  });
  const draftPlacements = resolveDraftPlacements(proposalsQuery.data ?? [], boardRequests, rides, department?.home_destination_id ?? undefined, routeCtx, serverMergeWindows);
  const draftPlacedRequestIds = new Set(draftPlacements.map((placement) => placement.requestId));
  const draftHiddenRideIds = new Set(draftPlacements.flatMap((placement) => (placement.replacesRideId ? [placement.replacesRideId] : [])));

  // REQ §13.94 (G10): a pending merge (draft, sent or accepted) is ONE block on the host's car -
  // the host window grown by the added driving. The host's own block and the guest's own
  // booking are hidden while it is pending, and the guest's booking leaves the conflict scan
  // (so nothing overlaps and no red stripes appear).
  const pendingMerges = (proposalsQuery.data ?? []).flatMap((proposal) => {
    if (proposal.type !== "merge" || !["draft", "sent", "accepted"].includes(proposal.status)) return [];
    const host = rides.find((ride) => ride.id === proposal.ride_id);
    const guest = boardRequests.find((request) => request.id === proposal.request_id);
    if (!host?.car_id || !host.id || !host.starts_at || !host.ends_at || !guest) return [];
    const leg = mergePayloadLeg(proposal.payload, guest);
    const preview = previewMerge(host, guest, leg, routeCtx);
    const payload = proposal.payload && typeof proposal.payload === "object" && !Array.isArray(proposal.payload) ? proposal.payload : {};
    const legacyStart = typeof payload.starts_at === "string" ? Date.parse(payload.starts_at) : Number.POSITIVE_INFINITY;
    const legacyEnd = typeof payload.ends_at === "string" ? Date.parse(payload.ends_at) : 0;
    const serverWindow = serverMergeWindows.get(proposal.id);
    const startsAt = new Date(Math.min(Date.parse(serverWindow?.startsAt ?? preview?.startsAt ?? host.starts_at), legacyStart)).toISOString();
    const endsAt = new Date(Math.max(Date.parse(serverWindow?.endsAt ?? preview?.endsAt ?? host.ends_at), legacyEnd)).toISOString();
    return [{ proposal, host, guest, startsAt, endsAt, leg, isDraft: proposal.status === "draft" }];
  });
  const mergeGuestRideIds = new Set(pendingMerges.flatMap((merge) => rides.filter((ride) => ride.id && ride.id !== merge.host.id
    && servedOf(ride).length > 0 && servedOf(ride).every((entry) => entry.request_id === merge.guest.id)).map((ride) => ride.id as string)));
  const mergeHostRideIds = new Set(pendingMerges.map((merge) => merge.host.id as string));
  const mergeHiddenRideIds = new Set([...mergeGuestRideIds, ...mergeHostRideIds]);
  const activeDayRidesAll = rides.filter(
    (r) => r.starts_at && dateKey(new Date(r.starts_at)) === selectedDay,
  );
  const activeDayRides = activeDayRidesAll.filter((r) => !(r.id && (draftHiddenRideIds.has(r.id) || mergeHiddenRideIds.has(r.id))));

  const weekStartMs = fromZonedTime(`${weekStart}T00:00:00`, TZ).getTime();

  const conflictScan =
    daySettings && department?.home_destination_id
      ? (() => {
          const validRides = rides.filter(
            (r): r is typeof r & { id: string; car_id: string; starts_at: string; ends_at: string; origin_id: string; destination_id: string } =>
              !!r.id && !!r.car_id && !!r.starts_at && !!r.ends_at && !!r.origin_id && !!r.destination_id && !mergeGuestRideIds.has(r.id),
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
              locationNeutral: isReservation(r),
            })),
            carIds: [...new Set(validRides.map((r) => r.car_id))],
            weekStartMs,
            bufferMinutes: weekSettings.turnaroundMinutes,
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

  const tightRideIds = tightScheduleRideIds(rides.filter((ride) => !(ride.id && mergeGuestRideIds.has(ride.id))).map((ride) => (isReservation(ride) ? { ...ride, origin_id: null, destination_id: null } : ride)), weekSettings.turnaroundMinutes, {
    homeLocationId: department?.home_destination_id,
    carBaseLocationId: new Map((carsQuery.data ?? []).map((c) => [c.id, c.base_location_id])),
  });
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
  const chainBreakByRideId = new Map<string, { carLocationId: string }>();
  for (const breaks of (conflictScan?.chainBreaksByCarId ?? new Map()).values()) {
    for (const b of breaks) chainBreakByRideId.set(b.rideId, { carLocationId: b.carLocationId });
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
      // QB21: where the car is at the START of the selected day (its away window containing that
      // instant), not the week's first away interval; with no scan yet, the stored location.
      locationBadge: conflictScan
        ? awayLocationAt(conflictScan.awayByCarId.get(c.id), weekStartMs, dayStartIso(selectedDay), destinationNameById)
        : carLocationsQuery.data?.find((l) => l.car_id === c.id)?.location_name ?? undefined,
      // REQUIREMENTS §13.93: the car's own base, shown only when it isn't the department home.
      baseBadge: base && base !== department?.home_destination_id
        ? tv("sadranBoard.carBase", { place: destinationNameById.get(base) ?? "" })
        : undefined,
      // REQUIREMENTS §13.93/SOLVER.md §1.3a: a warning only, shown on the last day of the week.
      weekEndAwayWarning: weekEndAway
        ? tv("sadranBoard.carAwayAtWeekEnd", { car: c.name, place: destinationNameById.get(weekEndAway.locationId) ?? "" })
        : undefined,
    };
  });

  // REQ §13.92 "Who": the Sadran may drag-swap car headers on any non-archived day — planning,
  // no notifications (owner A6). An archived week has no board route in practice (its own week
  // switcher excludes it), but a direct URL could still land here, so this still gates the drag.
  const boardCanSwapCars = weekRowQuery.data ? weekRowQuery.data.phase !== "archived" : false;

  const shadowedRideIds = new Set((rideChangesQuery.data ?? []).filter((change) => !change.is_planning).flatMap((change) => [change.ride_id, ...change.parties.map((party) => party.ride_id)]));
  const connectedRideIds = connectedPairRideIds(rides);
  const weekGridRides: WeekGridRide[] = activeDayRidesAll
    .filter((r) => r.id && r.car_id && r.starts_at && r.ends_at)
    .map((r) => ({
      id: r.id as string,
      carId: r.car_id as string,
      // The viewer's own ride (driver, or one of their own requests on it): the block is marked like on
      // the siddur and the car's header name is bold for that day (owner 2026-10-09).
      isMine: !!myProfileId && (r.driver_id === myProfileId
        || servedOf(r).some((entry) => boardRequests.find((request) => request.id === entry.request_id)?.requester_id === myProfileId)),
      startMinutes: Math.round((Date.parse(r.starts_at as string) - Date.parse(dayStartIso(selectedDay))) / 60_000),
      endMinutes: Math.round((Date.parse(r.ends_at as string) - Date.parse(dayStartIso(selectedDay))) / 60_000),
      requestedStartMinutes: (() => {
        const entry = servedOf(r).find((served) => served.role === "driver") ?? servedOf(r)[0];
        const request = boardRequests.find((request) => request.id === entry?.request_id);
        const window = request ? standaloneChauffeurWindow(request, weekSettings.chauffeurDwellMinutes) : null;
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
      // REQUIREMENTS §13.93 "Multi-stop rides" Display: "· דרך: פתח תקווה, תל אביב" — the stops by
      // name (owner 2026-10-05: not a count), only when the ride passes any (`rideViaNames`).
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
                carMove: r.pin_reason === "CAR_MOVE",
                startsAt: r.starts_at ?? undefined,
                relayPartner: relayPartnerOf(r, rides),
              })
            : (r.destination_name ?? ""));
        const via = viaLabel(rideViaNames(r));
        return via ? `${base} · ${via}` : base;
      })(),
      pinned: !!r.is_pinned,
      // REQ §13.94 (G10): an applied merge - the ride's own route carries boarding/alighting places.
      // R3B19: a lone הקפצה's own pickup/drop points are not a merge - only another request's points are.
      merged: (() => {
        const served = servedOf(r);
        const baseRequestId = (served.find((entry) => entry.role === "driver") ?? served[0])?.request_id ?? null;
        return parseRideRoute(r.route).some((point) => (point.kind === "board" || point.kind === "alight") && point.requestId !== baseRequestId);
      })(),
      connected: connectedRideIds.has(r.id as string),
      guests: addedGuestsOf(r.id as string, withChildNames(servedOf(r), requestsQuery.data ?? [])),
      needsDriver: !!r.needs_driver,
      luggage: servedOf(r).some((entry) => entry.luggage),
      luggageWaived: luggageMarker(servedOf(r)) === "waived",
      tightSchedule: tightRideIds.has(r.id as string),
      shadowed: shadowedRideIds.has(r.id as string),
      conflict: conflictRideIds.has(r.id as string),
      highlighted: focusedConflict?.id === r.id,
      pendingConsent: pendingConsentRideIds.has(r.id as string),
      rideTypeCode: representativeRideTypeCode(servedOf(r)),
      seriesIndex: r.series_index,
      seriesCount: r.series_count,
      chainBrokenWarning: r.id && chainBreakByRideId.has(r.id)
        ? tv("sadranBoard.carNotHereWarning", {
          // R5U6: name the ride (time + who) so the warning is readable away from its block (list mode, tooltips, screen readers).
          ride: [r.starts_at ? formatTime(new Date(r.starts_at)) : "", ...servedOf(r).map((entry) => entry.requester?.trim().split(/\s+/)[0] ?? "").filter(Boolean)].filter(Boolean).join(" · "),
          place: destinationNameById.get(chainBreakByRideId.get(r.id)!.carLocationId) ?? "",
        })
        : undefined,
    }));

  // REQ §13.94 (G10): the pending merge as one block - normal ride-type colours, the "· מאוחד"
  // marker, dashed draft/sent styling; never conflict stripes (it is not in the conflict scan).
  for (const merge of pendingMerges) {
    if (dateKey(merge.startsAt) !== selectedDay) continue;
    const host = weekGridRides.find((ride) => ride.id === merge.host.id);
    weekGridRides.push({ id: `merge:${merge.proposal.id}`, carId: merge.host.car_id!,
      startMinutes: Math.round((Date.parse(merge.startsAt) - Date.parse(dayStartIso(selectedDay))) / 60_000),
      endMinutes: Math.round((Date.parse(merge.endsAt) - Date.parse(dayStartIso(selectedDay))) / 60_000),
      label: `${host?.label ?? merge.host.driver_name ?? ""} · ${merge.guest.requester_full_name ?? ""}`,
      passengerSummary: host?.passengerSummary,
      merged: true, guests: [{ requestId: merge.guest.id, rideId: merge.host.id as string, name: merge.guest.requester_full_name ?? "" }],
      pendingConsent: !merge.isDraft, draft: merge.isDraft, needsDriver: !!merge.host.needs_driver, rideTypeCode: host?.rideTypeCode });
  }

  // REQ §13.94 overlay: shift/origin drafts as dashed "result" blocks (merge drafts are the
  // `merge:` ghosts above, drawn with the same draft styling).
  for (const placement of draftPlacements) {
    if (placement.type === "merge" || dateKey(placement.startsAt) !== selectedDay) continue;
    const request = boardRequests.find((r) => r.id === placement.requestId);
    const original = placement.replacesRideId ? weekGridRides.find((ride) => ride.id === placement.replacesRideId) : undefined;
    weekGridRides.push({
      id: `draft:${placement.proposalId}`,
      carId: placement.carId,
      startMinutes: Math.round((Date.parse(placement.startsAt) - Date.parse(dayStartIso(selectedDay))) / 60_000),
      endMinutes: Math.round((Date.parse(placement.endsAt) - Date.parse(dayStartIso(selectedDay))) / 60_000),
      // R3B19: an origin-change draft is drawn with the NEW origin (never the borrowed old label).
      // REQ §13.112 (a): a plan-B draft reads "תוכנית ב׳ · <name>" (the car's drop-off block; the request itself stays unmet).
      label: placement.type === "alternative" ? tv("sadranPlanB.draftLabel", { name: request?.requester_full_name ?? "" }) : (placement.type === "origin" ? undefined : original?.label) ?? (request && placement.leg === "return" && request.trip_type === "drop_off"
        // R5B11: a pickup draft reads "איסוף מ<place>" (never just "ל<place>").
        ? `${request.requester_full_name ?? ""} · ${tv("boardDrafts.pickupLabel", { place: request.destination_resolved_name ?? "" })} · ${tripTypeLabel(request.trip_type)}`
        : request
        ? `${request.requester_full_name ?? ""} · ${requestRouteLine({ originId: placement.originId ?? request.origin_id,
          originName: placement.originId && placement.originId !== request.origin_id ? destinationNameById.get(placement.originId) ?? request.origin_resolved_name : request.origin_resolved_name,
          originText: placement.originId && placement.originId !== request.origin_id ? null : request.origin_text, destination: request.destination_resolved_name ?? "", tripType: request.trip_type }, department?.home_destination_id)}`
        : ""),
      passengerSummary: original?.passengerSummary ?? (request ? ridePassengerSummary([{ ...request, requester: request.requester_full_name }]) : undefined),
      draft: true,
      needsDriver: false,
      rideTypeCode: original?.rideTypeCode ?? request?.ride_type_code,
    });
  }
  // The draft block replaces the original ride's block (kept in the list above only to borrow its label).
  for (let index = weekGridRides.length - 1; index >= 0; index--) {
    if (draftHiddenRideIds.has(weekGridRides[index]!.id) || mergeHiddenRideIds.has(weekGridRides[index]!.id)) weekGridRides.splice(index, 1);
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
      // R4U5: a car based away is not "away" while it stands at the kibbutz itself.
      if (away.locationId === homeId) return [];
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

  // REQ §13.94 (G4): a drop-off with a pickup is two cards (drop-off / pickup), each placed on its own.
  const allUnmetViews = unmetRequestViews(boardRequests, rides, { awaitingDriverRequestIds, draftPlacedRequestIds });
  const dayCounts = days.map((d) => ({
    rides: rides.filter((r) => r.starts_at && dateKey(new Date(r.starts_at)) === d).length,
    unmet: viewsOnDay(allUnmetViews, d, (iso) => dateKey(new Date(iso))).length,
  }));

  /**
   * Side panel + phone `UnmetList` (UX_FLOWS §4.2): every request of the
   * week with no ride, DB-derived (`isUnmetStatus`) so it's always
   * populated — sorted by solver score when a preview exists, otherwise by
   * departure time (`UnmetList.tsx`'s own sort), never empty just because
   * nobody has clicked "הרץ פותר" yet or the page was reloaded (bug #1).
   */
  const unmetItems = viewsOnDay(allUnmetViews, selectedDay, (iso) => dateKey(new Date(iso)))
    .map(({ request: r, leg }) => {
      const solverInfo = leg === "return" ? undefined : preview?.output.unmet.find((u) => u.requestId === r.id);
      return {
        request: r,
        leg,
        pendingProposalId: (proposalsQuery.data ?? []).find((p) => p.request_id === r.id && (p.status === "sent" || p.status === "accepted"))?.id,
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

  const phantomRides = packPhantomLanes(unmetItems.filter((item) => item.request.status !== "denied" && item.request.status !== "external").flatMap((item) => {
    const window = requestWindow(item.request);
    if (!window) return [];
    return [{ id: unmetItemId(item), startMinutes: (Date.parse(window.startsAt) - Date.parse(dayStartIso(selectedDay))) / 60_000,
      endMinutes: (Date.parse(window.endsAt) - Date.parse(dayStartIso(selectedDay))) / 60_000,
      label: `${item.leg ? `${item.leg === "out" ? he.tripLegs.out : he.tripLegs.pickup} · ` : ""}${item.request.requester_full_name ?? ""} · ${requestRouteLine({ originId: item.request.origin_id, originName: item.request.origin_id ? item.request.origin_resolved_name : null, originText: item.request.origin_text, destination: item.destinationName, tripType: item.request.trip_type }, department?.home_destination_id)}`, rideTypeCode: item.request.ride_type_code,
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
  // QB19: a draft/pending merge or shift hides the joiner's old booking - the drop checks must
  // ignore that booking too (it is replaced), or the next drop reports a phantom conflict.
  const dropCtx: BoardDropContext = {
    rides: rides.filter((ride) => !(ride.id && (draftHiddenRideIds.has(ride.id) || mergeGuestRideIds.has(ride.id)))),
    requests: boardRequests,
    cars: carsQuery.data ?? [],
    maintenanceBlocks: maintenanceQuery.data ?? [],
    seatConfigsByCarId,
    seatConfigsLoaded: seatConfigsQuery.isSuccess,
    unmetItems,
    selectedDay,
    chauffeurDwellMinutes: weekSettings.chauffeurDwellMinutes,
    // REQ item 108 c/D3: the maintenance check follows SQL (admin exempt, turnaround counted after the ride only).
    turnaroundMinutes: weekSettings.turnaroundMinutes,
    isAdmin,
    awayByCarId: conflictScan?.awayByCarId,
    weekStartMs,
    // REQUIREMENTS §13.93: each car's own base, already defaulted to the department home.
    carBaseLocationId: new Map((carsQuery.data ?? []).map((c) => [c.id, c.base_location_id ?? department?.home_destination_id ?? ""])),
    homeDestinationId: department?.home_destination_id ?? undefined,
    route: routeCtx,
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
    boardRequests,
    routeCtx,
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
    openRequestCount,
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
    draftPlacements,
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

function readStoredBoardDay(key: string): string | null {
  try { return window.sessionStorage.getItem(key); } catch { return null; }
}

function writeStoredBoardDay(key: string, day: string | null): void {
  try {
    if (day) window.sessionStorage.setItem(key, day);
    else window.sessionStorage.removeItem(key);
  } catch { /* storage unavailable: the in-memory pick still works */ }
}
