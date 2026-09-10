import { paths } from "@/app/routes";
import { TableViewControls } from "@/components/TableViewControls";
import { parseTimeToMinutes } from "@/features/solverBridge/buildSolverInput";
import { formatInTimeZone, fromZonedTime } from "date-fns-tz";
import { useEffect, useRef, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { toast } from "sonner";
import { useQuery } from "@tanstack/react-query";

import { datesOfWeek, formatWeekRangeLabel, todayInJerusalem } from "@/components/DateField";
import { EmptyState } from "@/components/EmptyState";
import { ErrorState } from "@/components/ErrorState";
import { PageHeader } from "@/components/PageHeader";
import { formatMinutes } from "@/components/TimeField15";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { PortalDialogContent } from "@/components/PortalDialogContent";
import { TimeField15, parseHHMM } from "@/components/TimeField15";
import { Textarea } from "@/components/ui/textarea";
import { WeekExcelExportButton } from "@/features/sadran/export/WeekExcelExportButton";
import { RequestDeviationsDialog } from "../../deviations/RequestDeviationsDialog";
import { expandedMergeWindow } from "../mergeWindow";
import { packPhantomLanes, requestStart, requestWindow, requestWithinFlex, standaloneChauffeurWindow } from "../phantomLanes";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { UNMET_DROP_ZONE_ATTR, WeekGrid, type WeekGridBlock, type WeekGridCar, type WeekGridDiscussionBlock, type WeekGridRide } from "@/components/WeekGrid";
import { WeekStrip } from "@/components/WeekStrip";
import { WaitlistGroupCard } from "@/features/waitlist/components/WaitlistGroupCard";
import { WaitlistGroupSheet } from "@/features/waitlist/components/WaitlistGroupSheet";
import { useWaitlistGroupsQuery } from "@/features/waitlist/hooks";
import { CalendarDays } from "lucide-react";
import { fetchCarSeatConfigs } from "@/features/fleet/api";
import { useRideTypes } from "@/features/fleet/hooks";
import { RideTypeLegend } from "@/components/RideTypeLegend";
import { BoardGridSkeleton } from "@/components/skeletons/BoardGridSkeleton";
import { useCarLocations, useDepartments, useRideChanges, useClaimRideDriverMutation, useCancelRideChangeMutation } from "@/features/siddur/hooks";
import { BoardPublicationActions } from "../../publish/components/BoardPublicationActions";
import { he, tv } from "@/i18n/he";
import { weekdayLabel } from "@/lib/dayLabels";
import { TZ, dateKey, formatTime } from "@/lib/time";
import { ridePublicDetails } from "@/lib/ridePublicDetails";
import { ridePassengerSummary } from "@/lib/ridePassengerSummary";
import { rideCoordinatorNotes } from "@/lib/rideCoordinatorNotes";
import { readLastUsedPolicyVersion, rememberLastUsedPolicyVersion } from "../../lastUsedPolicy";
import { sadranKeys } from "../../keys";

import { scanBoardConflicts, wouldOverlap, requestDayMismatchRideIds, tightScheduleRideIds } from "../geometry";
import { rideBlockLabel, resolveRideRealDestination } from "../rideLabel";
import { isUnmetStatus } from "../../unmetStatuses";
import {
  useActivePolicy,
  useAllWeekRides,
  useApplySolverResultMutation,
  useCancelRideMutation,
  useCarsForDepartment,
  useDepartmentSettings,
  useEditRideMutation,
  useMaintenanceBlocks,
  useUnassignRideMutation,
  usePolicyOptions,
  useProposalsForWeek,
  useWeekRequestsWithNames,
} from "../../hooks";
import {
  buildApplyPayload,
  gatherSolverContext,
  hashSolverInput,
  nowMs,
  representativeRideTypeCode,
  runSolve,
  servedOf,
  servedToEditRideLegs,
  withChildNames,
} from "../../solverRun";
import { useUndoStack } from "../useUndoStack";
import { BoardListMode } from "./BoardListMode";
import { BoardWeekSwitcher } from "./BoardWeekSwitcher";
import { FullResolveAction } from "./FullResolveAction";
import { RideSheet } from "./RideSheet";
import { UnmetList, type UnmetListItem } from "./UnmetList";

import type { EditRideInput, WeekRequestRow } from "../../api";
import type { Json } from "@/integrations/supabase/types";
import type { Suggestion, SolverOutput } from "@/solver";


interface BoardScreenProps {
  departmentId: string;
  weekStart: string;
}

/** `/sadran/:dept/:week/board` — the board (UX_FLOWS.md §4.2). */
export function BoardScreen({ departmentId, weekStart }: BoardScreenProps) {
  const navigate = useNavigate();
  const location = useLocation();

  const departmentsQuery = useDepartments();
  const department = (departmentsQuery.data ?? []).find((d) => d.id === departmentId);

  const days = datesOfWeek(weekStart);
  const today = todayInJerusalem();
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
  const [selectedRideId, setSelectedRideId] = useState<string | null>(null);
  const [selectedGroupId, setSelectedGroupId] = useState<string | null>(null);
  const [conflictJump, setConflictJump] = useState<{ rideId: string; sequence: number } | null>(null);
  const boardRef = useRef<HTMLDivElement>(null);

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

  const editRideMutation = useEditRideMutation();
  const claimDriverMutation = useClaimRideDriverMutation();
  const cancelRideChangeMutation = useCancelRideChangeMutation();
  const cancelRideMutation = useCancelRideMutation();
  const unassignRideMutation = useUnassignRideMutation();
  const [mergePrefill, setMergePrefill] = useState<Parameters<typeof goToComposer>[0] | null>(null);
  const [selectedUnmetId, setSelectedUnmetId] = useState<string | null>(null);
  const [reservation, setReservation] = useState<{ carId: string; start: string; end: string; notes: string } | null>(null);
  const applySolverResultMutation = useApplySolverResultMutation();
  const undoStack = useUndoStack<void>();
  const undoVersions = useRef(new Map<string, number>());
  const [autoSolving, setAutoSolving] = useState(false);

  // Vertical-board redesign (UX_FLOWS.md §20 "owner feedback: visible range
  // 06:00–24:00 by default; "הצג שעות מוקדמות" expands down to 00:00.
  const [showEarlyHours, setShowEarlyHours] = useState(false);
  const boardStartMinutes = departmentSettingsQuery.data?.board_start_time
    ? parseTimeToMinutes(departmentSettingsQuery.data.board_start_time) : 6 * 60;
  const dayStartMinutes = showEarlyHours ? 0 : boardStartMinutes;
  const dayEndMinutes = 24 * 60;

  // Drag-an-unmet-card-onto-a-car-column (UX_FLOWS §20 item 3): live hover
  // state reported by `UnmetList`'s own pointer tracking (it owns the
  // gesture since the drag starts on its cards, outside the grid) — the
  // grid only needs to know which car to highlight and whether the drop
  // would be valid right now.
  const [unmetDragHover, setUnmetDragHover] = useState<{ item: UnmetListItem; carId: string; minutes: number; hostRideId?: string } | null>(null);
  /** Collapsible bottom drawer for the md–lg gap (UX_FLOWS §20) — the side panel only shows at `lg:`. */
  const [tableView, setTableView] = useState(false);
  const [tableZoom, setTableZoom] = useState(1);

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
  const [previewLoading, setPreviewLoading] = useState(false);

  // A policy saved on this device is only a default, never an entitlement: if
  // it is not offered by this department, fall back to its active policy.
  const storedPolicyIsAvailable = (policyOptionsQuery.data ?? []).some((policy) => policy.policyVersionId === policyVersionOverride);
  const effectivePolicyVersionId = storedPolicyIsAvailable ? policyVersionOverride : activePolicyQuery.data?.policyVersionId ?? null;

  function selectPolicyVersion(policyVersionId: string) {
    setPolicyVersionOverride(policyVersionId);
  }

  function rememberUsedPolicy(policyVersionId: string) {
    rememberLastUsedPolicyVersion(policyVersionId);
    setPolicyVersionOverride(policyVersionId);
  }

  /**
   * Populates the unmet list's per-request score/suggestions by running the
   * pure solver client-side (SOLVER.md §2), without persisting anything —
   * triggered by "הרץ פותר" (a click handler, not an effect: this board
   * deliberately does not auto-run on mount, unlike the dashboard's result
   * sheet flow, to keep every solver invocation an explicit Sadran action;
   * see the stage 2b report).
   *
   * The ordinary preview matches remaining-only autofill. Full solving is
   * a separate FullResolveAction with an explicit replacement confirmation.
   */
  async function computePreview() {
    const chosen = (policyOptionsQuery.data ?? []).find((p) => p.policyVersionId === effectivePolicyVersionId);
    const policy = chosen ?? activePolicyQuery.data;
    if (!policy || !department?.home_destination_id) return;
    setPreviewLoading(true);
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
        },
        mode: "remaining",
      });
      const output = runSolve(context.input);
      rememberUsedPolicy(policy.policyVersionId);
      setPreview({ output, policyVersionId: policy.policyVersionId });
    } catch {
      // Non-blocking: the board still works from persisted request/ride data alone.
    } finally {
      setPreviewLoading(false);
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
    } catch {
      // toast already shown by the mutation, or silently a no-op if nothing was open
    } finally {
      setAutoSolving(false);
    }
  }

  const policyIsStale = !!preview && preview.policyVersionId !== effectivePolicyVersionId;

  const daySettings = departmentSettingsQuery.data;
  const rides = ridesQuery.data ?? [];
  const awaitingDriverRequestIds = new Set(rides.filter((ride) => ride.needs_driver).flatMap((ride) => servedOf(ride).map((entry) => entry.request_id)));
  const activeDayRides = rides.filter(
    (r) => r.starts_at && dateKey(new Date(r.starts_at)) === selectedDay,
  );

  const conflictScan =
    daySettings && department?.home_destination_id
      ? (() => {
          const validRides = rides.filter(
            (r): r is typeof r & { id: string; car_id: string; starts_at: string; ends_at: string; origin_id: string; destination_id: string } =>
              !!r.id && !!r.car_id && !!r.starts_at && !!r.ends_at && !!r.origin_id && !!r.destination_id,
          );
          const weekStartMs = fromZonedTime(`${weekStart}T00:00:00`, TZ).getTime();
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
              overnightAck: !!r.overnight_ack_by,
              turnaroundMinutes: r.turnaround_override_minutes ?? undefined,
            })),
            carIds: [...new Set(validRides.map((r) => r.car_id))],
            weekStartMs,
            bufferMinutes: daySettings.turnaround_minutes,
            homeLocationId: department.home_destination_id,
            days: days96,
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
  const focusedConflictIndex = conflicts.findIndex((ride) => ride.id === conflictJump?.rideId);
  const focusedConflict = conflicts[focusedConflictIndex];

  function jumpToNextConflict() {
    const next = conflicts[(focusedConflictIndex + 1) % conflicts.length];
    if (!next) return;
    setSelectedDay(dateKey(next.starts_at));
    const minutes = Number(formatInTimeZone(next.starts_at, TZ, "H")) * 60 + Number(formatInTimeZone(next.starts_at, TZ, "m"));
    if (minutes < dayStartMinutes) setShowEarlyHours(true);
    setConflictJump({ rideId: next.id, sequence: (conflictJump?.sequence ?? 0) + 1 });
  }

  useEffect(() => {
    if (!conflictJump) return;
    // The chosen day and phone's car list have rendered before finding the target.
    const target = [...(boardRef.current?.querySelectorAll<HTMLElement>("[data-ride-id]") ?? [])]
      .find((element) => element.dataset.rideId === conflictJump.rideId && element.getClientRects().length > 0);
    target?.focus({ preventScroll: true });
    target?.scrollIntoView({ behavior: "smooth", block: "start", inline: "center" });
  }, [conflictJump]);

  const pendingConsentRideIds = new Set(
    (proposalsQuery.data ?? []).filter((p) => p.status === "sent" && p.ride_id).map((p) => p.ride_id as string),
  );

  function dayStartIso(day: string): string {
    return fromZonedTime(`${day}T00:00:00`, TZ).toISOString();
  }

  const weekGridCars: WeekGridCar[] = (carsQuery.data ?? []).map((c) => ({
    id: c.id,
    name: c.name,
    group: c.type,
    locationBadge: carLocationsQuery.data?.find((l) => l.car_id === c.id)?.location_name ?? undefined,
  }));

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
      label: (!servedOf(r).length && r.notes) || (
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
            })
          : (r.destination_name ?? "")),
      pinned: !!r.is_pinned,
      needsDriver: !!r.needs_driver,
      tightSchedule: tightRideIds.has(r.id as string),
      shadowed: shadowedRideIds.has(r.id as string),
      conflict: conflictRideIds.has(r.id as string),
      highlighted: focusedConflict?.id === r.id,
      pendingConsent: pendingConsentRideIds.has(r.id as string),
      rideTypeCode: representativeRideTypeCode(servedOf(r)),
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
    return startMinutes < 1440 && endMinutes > 0 ? [{ id: block.id, carId: block.car_id, startMinutes, endMinutes }] : [];
  });

  // Contested waiting-list groups (REQ §13.75, UX_FLOWS.md §4.2): once a day is published, its
  // open groups no longer show as separate `UnmetList` items — they render as one "בדיון" lane
  // block/card, the same as the member siddur.
  const dayWaitlistGroups = (waitlistGroupsQuery.data ?? []).filter((group) => group.day === selectedDay);
  const selectedWaitlistGroup = (waitlistGroupsQuery.data ?? []).find((group) => group.id === selectedGroupId) ?? null;
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
  const unmetItems: UnmetListItem[] = (requestsQuery.data ?? [])
    .filter((r) => isUnmetStatus(r.status) && !awaitingDriverRequestIds.has(r.id) && requestStart(r) && dateKey(new Date(requestStart(r)!)) === selectedDay)
    .map((r) => ({
      request: r,
      destinationName: r.destination_resolved_name ?? "—",
      solverInfo: preview?.output.unmet.find((u) => u.requestId === r.id),
    }));

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
  const selectedUnmet = unmetItems.find((item) => item.request.id === selectedUnmetId);

  const selectedPlanningChange = (rideChangesQuery.data ?? []).find((change) => change.is_planning && `change:${change.id}` === selectedRideId);
  const selectedRide = rides.find((r) => r.id === (selectedPlanningChange?.ride_id ?? selectedRideId)) ?? null;
  const selectedRideDriverName = selectedRide?.driver_name ?? null;

  const seatConfigsByCarId = new Map<string, { adults: number; child_seats: number; boosters: number }[]>();
  for (const sc of seatConfigsQuery.data ?? []) {
    const list = seatConfigsByCarId.get(sc.car_id) ?? [];
    list.push({ adults: sc.adults, child_seats: sc.child_seats, boosters: sc.boosters });
    seatConfigsByCarId.set(sc.car_id, list);
  }

  function passengersOf(ride: (typeof rides)[number]) {
    const served = servedOf(ride);
    return served.reduce(
      (acc, s) => ({ adults: acc.adults + s.adults, childSeats: acc.childSeats + s.child_seats, boosters: acc.boosters + s.boosters }),
      { adults: served.length && !served.some((entry) => entry.role === "driver") ? 1 : 0, childSeats: 0, boosters: 0 },
    );
  }

  /** Does any of `carId`'s seat configurations fit `need`? No configs on record -> don't block (unknown, not invalid). */
  function seatsFit(carId: string, need: { adults: number; childSeats: number; boosters: number }): boolean {
    const configs = seatConfigsByCarId.get(carId) ?? [];
    if (configs.length === 0) return true;
    return configs.some((c) => c.adults >= need.adults && c.child_seats >= need.childSeats && c.boosters >= need.boosters);
  }

  function unavailable(carId: string, startsAt: string, endsAt: string): boolean {
    if ((carsQuery.data ?? []).find((car) => car.id === carId)?.status !== "active") return true;
    return wouldOverlap({ startsAt, endsAt }, (maintenanceQuery.data ?? []).filter((block) => block.car_id === carId)
      .map((block) => ({ startsAt: block.starts_at, endsAt: block.ends_at })), 0);
  }

  function mergeCandidateForRide(rideId: string, carId: string, _startsAt: string, _endsAt: string, hostRideId?: string) {
    const source = rides.find((ride) => ride.id === rideId);
    if (!source?.needs_driver || !hostRideId) return null;
    const host = rides.find((ride) => ride.id !== rideId && ride.car_id === carId && ride.starts_at && ride.ends_at
      && ride.id === hostRideId && !!ride.driver_id && !ride.needs_driver);
    const guest = source ? servedOf(source).find((entry) => entry.role === "driver") ?? servedOf(source)[0] : undefined;
    if (!source?.starts_at || !source.ends_at || !host?.starts_at || !host.ends_at || !guest) return null;
    const request = (requestsQuery.data ?? []).find((request) => request.id === guest.request_id);
    const window = source.needs_driver && request ? requestWindow(request) : { startsAt: source.starts_at, endsAt: source.ends_at };
    return window ? { host, source, request, window: expandedMergeWindow({ startsAt: host.starts_at, endsAt: host.ends_at }, window) } : null;
  }

  /** Validate the live preview window, including phantom requests dragged into real cars. */
  function isDropTargetValid(rideId: string, carId: string, startMinutes: number, endMinutes: number, hostRideId?: string): boolean {
    if (carId.startsWith("phantom:")) return !rideId.startsWith("request:");
    if (rideId.startsWith("request:")) {
      const item = unmetItems.find((item) => `request:${item.request.id}` === rideId);
      return !!item && isUnmetDropValid(item, carId, startMinutes, hostRideId);
    }
    if (startMinutes < 0 || endMinutes > 1439 || endMinutes <= startMinutes || unavailable(carId, minutesIso(startMinutes), minutesIso(endMinutes))) return false;
    const ride = rides.find((r) => r.id === rideId);
    if (!ride?.starts_at || !ride.ends_at) return true;
    const merge = mergeCandidateForRide(rideId, carId, minutesIso(startMinutes), minutesIso(endMinutes), hostRideId);
    if (merge) {
      if (!merge.host.driver_id || merge.host.needs_driver || !merge.request || unavailable(carId, merge.window.startsAt, merge.window.endsAt)) return false;
      const hostNeed = passengersOf(merge.host);
      if (!seatsFit(carId, { adults: hostNeed.adults + merge.request.adults, childSeats: hostNeed.childSeats + merge.request.child_seats, boosters: hostNeed.boosters + merge.request.boosters })) return false;
      return !wouldOverlap(merge.window, rides.filter((other) => other.id !== rideId && other.id !== merge.host.id && other.car_id === carId && other.starts_at && other.ends_at)
        .map((other) => ({ startsAt: other.starts_at!, endsAt: other.ends_at! })), 0);
    }
    if (!seatsFit(carId, passengersOf(ride))) return false;
    return true;
  }

  function unmetRequestPassengers(r: WeekRequestRow) {
    return { adults: r.adults + (r.trip_shape === "round_trip" ? 0 : 1), childSeats: r.child_seats, boosters: r.boosters };
  }

  /** Shared timestamp conversion for the current day and snapped preview/drop windows. */
  function minutesIso(minutes: number): string {
    const date = new Date(`${selectedDay}T12:00:00Z`);
    date.setUTCDate(date.getUTCDate() + Math.floor(minutes / 1440));
    const time = formatMinutes(((minutes % 1440) + 1440) % 1440);
    return fromZonedTime(`${date.toISOString().slice(0, 10)}T${time}:00`, TZ).toISOString();
  }

  function unmetCandidateWindow(item: UnmetListItem, minutes: number, standalone = false): { startsAt: string; endsAt: string } | null {
    const req = item.request;
    const passenger = requestWindow(req);
    const original = standalone ? standaloneChauffeurWindow(req, daySettings?.chauffeur_dwell_minutes ?? 10) : passenger;
    if (!original || !passenger || !requestStart(req) || dateKey(new Date(requestStart(req)!)) !== selectedDay) return null;
    const duration = (Date.parse(original.endsAt) - Date.parse(original.startsAt)) / 60_000;
    const requestedMinutes = (Date.parse(passenger.startsAt) - Date.parse(dayStartIso(selectedDay))) / 60_000;
    if (Math.abs(minutes - requestedMinutes) <= 15) minutes = requestedMinutes;
    const start = minutes - (standalone && req.trip_shape === "one_way_from" ? (Date.parse(passenger.startsAt) - Date.parse(original.startsAt)) / 60_000 : 0);
    if (start < 0 || start + duration > 1439) return null;
    return { startsAt: minutesIso(start), endsAt: minutesIso(start + duration) };
  }

  function unmetMergeHost(item: UnmetListItem, carId: string, _minutes: number, hostRideId?: string) {
    if (item.request.trip_shape === "round_trip" || !hostRideId) return undefined;
    return rides.find((ride) => ride.id === hostRideId && ride.car_id === carId && !!ride.driver_id && !ride.needs_driver);
  }

  function unmetPreviewWindow(item: UnmetListItem, carId: string, minutes: number, hostRideId?: string) {
    const host = unmetMergeHost(item, carId, minutes, hostRideId);
    const passenger = requestWindow(item.request);
    return host?.starts_at && host.ends_at && passenger
      ? expandedMergeWindow({ startsAt: host.starts_at, endsAt: host.ends_at }, passenger)
      : unmetCandidateWindow(item, minutes, true);
  }

  /** Includes the whole chauffeur return block or expanded host, using actual
   * overlap rather than rejecting coordinator-approved short turnaround gaps. */
  function isUnmetDropValid(item: UnmetListItem, carId: string, minutes: number, hostRideId?: string): boolean {
    const window = unmetPreviewWindow(item, carId, minutes, hostRideId);
    if (!window || carId.startsWith("phantom:") || unavailable(carId, window.startsAt, window.endsAt)) return false;
    const host = unmetMergeHost(item, carId, minutes, hostRideId);
    if (host && (!host.driver_id || host.needs_driver)) return false;
    const need = host ? passengersOf(host) : { adults: 1, childSeats: 0, boosters: 0 };
    if (!seatsFit(carId, host || item.request.trip_shape !== "round_trip"
      ? { adults: need.adults + item.request.adults, childSeats: need.childSeats + item.request.child_seats, boosters: need.boosters + item.request.boosters }
      : unmetRequestPassengers(item.request))) return false;
    const others = rides.filter((ride) => ride.id !== host?.id && ride.car_id === carId && ride.starts_at && ride.ends_at)
      .map((ride) => ({ startsAt: ride.starts_at!, endsAt: ride.ends_at! }));
    return !host || !wouldOverlap(window, others, 0);
  }

  /** Assign a request leg or prepare a proposal when sharing/relay coordination is required. */
  async function handlePlaceUnmetRequest(item: UnmetListItem, carId: string, minutes: number, droppedOnRideId?: string) {
    setUnmetDragHover(null);
    const req = item.request;
    if (carId.startsWith("phantom:")) return;
    if (!requestStart(req) || dateKey(new Date(requestStart(req)!)) !== selectedDay) {
      toast.error(he.sadranBoard.wrongDay); return;
    }
    let window = unmetCandidateWindow(item, minutes);
    if (!window || !department?.home_destination_id) {
      toast.error(he.sadranBoard.invalidWindow);
      return;
    }
    const host = unmetMergeHost(item, carId, minutes, droppedOnRideId);
    if (host?.id && host.starts_at && host.ends_at) {
      if (!host.driver_id || host.needs_driver) { toast.error(he.boardCoordination.mergeNeedsDriver); return; }
      if (!isUnmetDropValid(item, carId, minutes, droppedOnRideId)) { toast.error(he.sadranBoard.dragInvalidOverlapToast); return; }
      const original = requestWindow(req)!;
      const expanded = expandedMergeWindow({ startsAt: host.starts_at, endsAt: host.ends_at }, original);
      setMergePrefill({ requestId: req.id, rideId: host.id, type: "merge", payload: { ride_id: host.id,
        starts_at: expanded.startsAt, ends_at: expanded.endsAt,
        legs: [{ ride_id: host.id, role: "passenger", leg: req.trip_shape === "round_trip" ? "both" : req.trip_shape === "one_way_from" ? "return" : "out", car_mode: "passenger" }] } });
      return;
    }
    window = unmetCandidateWindow(item, minutes, true);
    if (!window) { toast.error(he.sadranBoard.invalidWindow); return; }
    if (unavailable(carId, window.startsAt, window.endsAt)) { toast.error(he.sadranBoard.maintenanceUnavailable); return; }
    if (!seatsFit(carId, unmetRequestPassengers(req))) {
      toast.error(he.sadranBoard.dragInvalidSeatsToast);
      return;
    }
    if (!requestWithinFlex(req, window.startsAt, window.endsAt)) {
      goToComposer({ requestId: req.id, rideId: null, type: "shift", payload: req.trip_shape === "round_trip" ? { car_id: carId, depart_at: window.startsAt, return_at: window.endsAt, origin_id: department.home_destination_id, destination_id: department.home_destination_id } : req.trip_shape === "one_way_from" ? { return_at: window.endsAt } : { depart_at: window.startsAt } });
      return;
    }
    try {
      await editRideMutation.mutateAsync({
        input: {
          department_id: departmentId,
          week_start: weekStart,
          car_id: carId,
          starts_at: window.startsAt,
          ends_at: window.endsAt,
          origin_id: department.home_destination_id,
          destination_id: department.home_destination_id,
          driver_id: req.trip_shape === "round_trip" ? req.requester_id : null,
          needs_driver: req.trip_shape !== "round_trip",
          allow_conflict: true,
          is_pinned: true,
          pin_reason: "SADRAN_MANUAL",
          served: [{ request_id: req.id, role: req.trip_shape === "round_trip" ? "driver" : "passenger", leg: req.trip_shape === "round_trip" ? "both" : req.trip_shape === "one_way_from" ? "return" : "out", car_mode: req.trip_shape === "round_trip" ? "keep" : "chauffeur" }],
        },
        departmentId,
        weekStart,
      });
      const carName = (carsQuery.data ?? []).find((c) => c.id === carId)?.name ?? "";
      toast.success(req.trip_shape === "round_trip" ? tv("sadranBoard.dragPlacedToast", { car: carName, start: formatMinutes(minutes) }) : he.boardCoordination.standaloneSaved);
    } catch {
      // The mutation reports validation errors; keep the request on its phantom lane.
    }
  }

  /** Return every served request to the unmet board atomically. */
  async function handleUnassignRide(rideId: string) {
    const ride = rides.find((r) => r.id === rideId);
    if (!ride?.version) return;
    try {
      await unassignRideMutation.mutateAsync({
        rideId,
        expectedVersion: ride.version,
        departmentId,
        weekStart,
      });
      toast.success(he.sadranBoard.unassignedToast);
    } catch {
      // toast already shown by the mutation
    }
  }

  function goToComposer(prefill: {
    requestId: string;
    rideId: string | null;
    type: "shift" | "merge" | "deny" | "external";
    payload: Record<string, unknown>;
    proposalId?: string;
  }) {
    navigate(paths.sadran.composer(departmentId, weekStart), { state: { ...prefill, returnTo: location.pathname + location.search } });
  }

  function handleRideClick(id: string) {
    if (id.startsWith("change:")) {
      const change = (rideChangesQuery.data ?? []).find((change) => `change:${change.id}` === id);
      if (change) setSelectedRideId(change.is_planning ? id : change.ride_id);
      return;
    }
    if (id.startsWith("request:")) { setSelectedUnmetId(id.slice(8)); return; }
    if (id.startsWith("merge:")) {
      const merge = pendingMerges.find((entry) => entry.proposal.id === id.slice(6));
      if (merge) goToComposer({ requestId: merge.guest.id, rideId: merge.host.id, type: "merge", payload: merge.proposal.payload as Record<string, unknown>, proposalId: merge.proposal.id });
      return;
    }
    setSelectedRideId(id);
  }


  async function handleRideDrop(rideId: string, carId: string, startMinutes: number, droppedOnRideId?: string, resizedEndMinutes?: number) {
    const planningChange = (rideChangesQuery.data ?? []).find((change) => change.is_planning && `change:${change.id}` === rideId);
    if (planningChange) {
      if (carId.startsWith("phantom:")) { await cancelRideChangeMutation.mutateAsync(planningChange.id); return; }
      rideId = planningChange.ride_id;
      resizedEndMinutes ??= startMinutes + (Date.parse(planningChange.ends_at) - Date.parse(planningChange.starts_at)) / 60_000;
    }
    if (rideId.startsWith("request:")) {
      const item = unmetItems.find((item) => `request:${item.request.id}` === rideId);
      if (item) await handlePlaceUnmetRequest(item, carId, startMinutes, droppedOnRideId);
      return;
    }
    if (carId.startsWith("phantom:")) { await handleUnassignRide(rideId); return; }
    const ride = rides.find((r) => r.id === rideId);
    if (!ride?.id || !ride.starts_at || !ride.ends_at || !ride.car_id || !ride.origin_id || !ride.destination_id) return;

    if (ride.needs_driver && droppedOnRideId && droppedOnRideId !== rideId && rides.some((other) => other.id === droppedOnRideId && !!other.driver_id && !other.needs_driver)) {
      const driverEntry = servedOf(ride).find((s) => s.role === "driver") ?? servedOf(ride)[0];
      if (driverEntry?.request_id) {
        const host = rides.find((candidate) => candidate.id === droppedOnRideId);
        if (!host?.starts_at || !host.ends_at) return;
        if (!host.driver_id || host.needs_driver) { toast.error(he.boardCoordination.mergeNeedsDriver); return; }
        const sourceRequest = (requestsQuery.data ?? []).find((request) => request.id === driverEntry.request_id);
        const guestWindow = ride.needs_driver && sourceRequest ? requestWindow(sourceRequest) : null;
        const expanded = expandedMergeWindow({ startsAt: host.starts_at, endsAt: host.ends_at }, guestWindow ?? { startsAt: ride.starts_at, endsAt: ride.ends_at });
        setMergePrefill({
          requestId: driverEntry.request_id,
          rideId: droppedOnRideId,
          type: "merge",
          payload: {
            ride_id: droppedOnRideId,
            starts_at: expanded.startsAt, ends_at: expanded.endsAt,
            legs: [{ ride_id: droppedOnRideId, role: "passenger", leg: driverEntry.leg ?? "both", car_mode: "passenger" }],
          },
        });
      }
      return;
    }

    const oldStartMinutes = Math.round((Date.parse(ride.starts_at) - Date.parse(dayStartIso(selectedDay))) / 60_000);
    const oldEndMinutes = Math.round((Date.parse(ride.ends_at) - Date.parse(dayStartIso(selectedDay))) / 60_000);
    const durationMinutes = oldEndMinutes - oldStartMinutes;
    const rawEndMinutes = resizedEndMinutes ?? startMinutes + durationMinutes;
    const newEndMinutes = rawEndMinutes === 1439 ? 1439 : Math.round(rawEndMinutes / 15) * 15;
    if (startMinutes < 0 || newEndMinutes > 1439 || newEndMinutes <= startMinutes) { toast.error(he.sadranBoard.invalidWindow); return; }

    const driverEntry = servedOf(ride).find((s) => s.role === "driver") ?? servedOf(ride)[0];
    const driverRequest = driverEntry ? (requestsQuery.data ?? []).find((r) => r.id === driverEntry.request_id) : undefined;
    const newStartsAt = minutesIso(startMinutes);
    const newEndsAt = minutesIso(newEndMinutes);
    if (unavailable(carId, newStartsAt, newEndsAt)) { toast.error(he.sadranBoard.maintenanceUnavailable); return; }
    const servedRequests = servedOf(ride).map((entry) => (requestsQuery.data ?? []).find((req) => req.id === entry.request_id)).filter((req): req is WeekRequestRow => !!req);
    const withinDepartFlex = servedRequests.every((req) => requestWithinFlex(req, newStartsAt, newEndsAt));

    // Conflicts checked and reported in Hebrew *before* touching the DB
    // (owner bug report #2: "confirm conflicts — overlap/buffer/location/
    // seat fit — are checked and reported in Hebrew on drop"). Location/
    // overnight-chain is still enforced server-side by `assert_car_chain`
    // inside `edit_ride` (`lib/rpc.ts`'s `car_chain_broken` -> `he.errors.
    // carChainBroken`); seat-fit and same-car overlap have no DB check at
    // all today, so they're validated here against the *real* dropped time.
    if (carId !== ride.car_id && !seatsFit(carId, passengersOf(ride))) {
      toast.error(he.sadranBoard.seatMismatchToast);
      return;
    }
    const otherRidesOnTargetCar = rides
      .filter((r) => r.id !== ride.id && r.car_id === carId && r.starts_at && r.ends_at)
      .map((r) => ({ startsAt: r.starts_at as string, endsAt: r.ends_at as string }));
    const hasCollision = wouldOverlap({ startsAt: newStartsAt, endsAt: newEndsAt }, otherRidesOnTargetCar, 0);

    if (withinDepartFlex || (hasCollision && ride.status !== "draft")) {
      const prevInput: EditRideInput = {
        id: ride.id,
        department_id: departmentId,
        week_start: weekStart,
        car_id: ride.car_id,
        starts_at: ride.starts_at,
        ends_at: ride.ends_at,
        origin_id: ride.origin_id,
        destination_id: ride.destination_id,
        driver_id: ride.driver_id,
        needs_driver: !!ride.needs_driver,
        notes: ride.notes ?? undefined,
        is_pinned: !!ride.is_pinned,
        pin_reason: ride.pin_reason,
        served: servedToEditRideLegs(servedOf(ride)),
      };
      // Manual edits auto-pin (UX_FLOWS §4.2 "Pin 🔒 ... All manual edits
      // auto-pin"; REQUIREMENTS §7.1) — otherwise the very next re-solve
      // (or "auto-solve remaining") treats this Sadran-moved ride as an
      // ordinary solver-made draft and may delete it (owner bug report #5).
      const nextInput: EditRideInput = {
        ...prevInput,
        car_id: carId,
        starts_at: newStartsAt,
        ends_at: newEndsAt,
        is_pinned: true,
        allow_conflict: true,
        pin_reason: prevInput.pin_reason ?? "SADRAN_MANUAL",
      };
      try {
        await editRideMutation.mutateAsync({ input: nextInput, expectedVersion: planningChange?.expected_version ?? ride.version ?? undefined, departmentId, weekStart });
        if (hasCollision && ride.status !== "draft") { toast.success(he.boardCoordination.planningSaved); return; }
        undoVersions.current.set(rideId, (ride.version ?? 0) + 1);
        toast.success(he.sadranBoard.dragAppliedToast);
        undoStack.push({
          label: ride.destination_name ?? ride.id,
          run: async () => {
            const expectedVersion = undoVersions.current.get(rideId) ?? (ride.version ?? 0) + 1;
            await editRideMutation.mutateAsync({ input: prevInput, expectedVersion, departmentId, weekStart });
            undoVersions.current.set(rideId, expectedVersion + 1);
          },
        });
      } catch {
        // toast already shown by the mutation
      }
    } else if (driverRequest) {
      toast(he.sadranBoard.dragBeyondFlexToast);
      goToComposer({
        requestId: driverRequest.id,
        rideId: ride.id,
        type: "shift",
        payload: { car_id: carId, depart_at: newStartsAt, return_at: newEndsAt, origin_id: ride.origin_id, destination_id: ride.destination_id, ride_id: ride.id },
      });
    }
  }

  function handleRideResize(rideId: string, edge: "start" | "end", minutes: number) {
    const ride = rides.find((r) => r.id === rideId);
    if (!ride?.car_id) return;
    const oldStartMinutes = Math.round((Date.parse(ride.starts_at as string) - Date.parse(dayStartIso(selectedDay))) / 60_000);
    const oldEndMinutes = Math.round((Date.parse(ride.ends_at as string) - Date.parse(dayStartIso(selectedDay))) / 60_000);
    const newStart = edge === "start" ? minutes : oldStartMinutes;
    const newEnd = edge === "end" ? minutes : oldEndMinutes;
    if (newEnd <= newStart) return;
    void handleRideDrop(rideId, ride.car_id, newStart, undefined, newEnd);
  }

  function handleUnmetDecision(item: UnmetListItem, type: "deny" | "shift" | "external") {
    goToComposer({ requestId: item.request.id, rideId: null, type, payload: {} });
  }

  async function saveReservation() {
    if (!reservation || !department?.home_destination_id) return;
    const start = parseHHMM(reservation.start);
    const end = parseHHMM(reservation.end);
    if (start == null || end == null || end <= start || !reservation.notes.trim()) { toast.error(he.sadranBoard.invalidWindow); return; }
    try {
      await editRideMutation.mutateAsync({ input: { department_id: departmentId, week_start: weekStart, car_id: reservation.carId,
        starts_at: minutesIso(start), ends_at: minutesIso(end), origin_id: department.home_destination_id, destination_id: department.home_destination_id,
        driver_id: null, served: [], notes: reservation.notes.trim(), is_pinned: true, pin_reason: "SADRAN_MANUAL" }, departmentId, weekStart });
      setReservation(null); toast.success(he.sadranBoard.reservationSaved);
    } catch { /* Mutation reports errors. */ }
  }

  function handleUnmetAction(item: UnmetListItem, suggestion: Suggestion | null) {
    if (!suggestion) {
      goToComposer({ requestId: item.request.id, rideId: null, type: "shift", payload: {} });
      return;
    }
    switch (suggestion.kind) {
      case "shiftBeyondFlex":
      case "convertToRoundTrip":
        goToComposer({ requestId: item.request.id, rideId: null, type: "shift", payload: {} });
        return;
      case "merge":
      case "splitLegs":
        goToComposer({ requestId: item.request.id, rideId: suggestion.kind === "merge" ? suggestion.hostRideId : null, type: "merge", payload: {} });
        return;
      case "externalHint":
        goToComposer({ requestId: item.request.id, rideId: null, type: "external", payload: { hint: suggestion.hint } });
        return;
      case "deny":
        goToComposer({ requestId: item.request.id, rideId: null, type: "deny", payload: {} });
        return;
      default:
        return;
    }
  }

  async function handleUndo() {
    try {
      const result = await undoStack.undo();
      if (result) toast.success(tv("sadranBoard.undoToast", { label: result.label }));
      else toast(he.sadranBoard.undoNothing);
    } catch { /* Version conflicts are reported by the mutation. */ }
  }

  if (requestsQuery.isError || ridesQuery.isError) {
    return <ErrorState onRetry={() => ridesQuery.refetch()} />;
  }

  // Papercut fix (usability sweep): the board used to render immediately
  // with empty arrays while its own data was still in flight — an empty
  // grid and "לא שובצו (0)" for a moment on every load, indistinguishable
  // from an actually-empty week (the same misleading "nothing happened"
  // impression as bug #4). `route-level useSadranRouteParams` loading state
  // only covers the authorization check, not this screen's own queries.
  if (requestsQuery.isLoading || ridesQuery.isLoading || carsQuery.isLoading) {
    return (
      <div className="mx-auto max-w-6xl space-y-3 p-4 pb-24">
        <PageHeader title={he.screen.board.title} subtitle={formatWeekRangeLabel(weekStart)} />
        <BoardGridSkeleton />
      </div>
    );
  }

  const conflictCount = conflicts.length;
  const unmetPreview = unmetDragHover ? unmetPreviewWindow(unmetDragHover.item, unmetDragHover.carId, unmetDragHover.minutes, unmetDragHover.hostRideId) : null;

  return (
    <div ref={boardRef} className="mx-auto max-w-6xl space-y-3 p-4 pb-24">
      <PageHeader title={he.screen.board.title} subtitle={formatWeekRangeLabel(weekStart)} />
      <BoardWeekSwitcher departmentId={departmentId} weekStart={weekStart} />

      <div className="flex flex-wrap items-center gap-2">
        <RequestDeviationsDialog departmentId={departmentId} weekStart={weekStart} />
        <WeekExcelExportButton departmentId={departmentId} weekStart={weekStart} />
        <Select value={effectivePolicyVersionId ?? undefined} onValueChange={selectPolicyVersion}>
          <SelectTrigger className="w-48">
            <SelectValue placeholder={he.board.policy} />
          </SelectTrigger>
          <SelectContent>
            {(policyOptionsQuery.data ?? []).map((p) => (
              <SelectItem key={p.policyVersionId} value={p.policyVersionId}>
                {p.name} · {p.versionNo}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {policyIsStale ? (
          <Badge variant="outline" className="border-amber-500 text-amber-600">
            {he.board.policyChanged}
          </Badge>
        ) : null}
        <Button variant="outline" size="sm" onClick={() => void computePreview()} disabled={previewLoading}>
          {previewLoading ? he.sadranDashboard.solving : he.action.runSolver}
        </Button>
        <Button variant="outline" size="sm" onClick={handleAutoSolveRemaining} disabled={autoSolving}>
          {autoSolving ? he.sadranDashboard.solving : he.action.autoSolveRemaining}
        </Button>
        <FullResolveAction key={`${departmentId}:${weekStart}:${effectivePolicyVersionId}`} departmentId={departmentId} weekStart={weekStart}
          homeDestinationId={department?.home_destination_id ?? null} disabled={autoSolving}
          onPolicyUsed={rememberUsedPolicy}
          policy={(policyOptionsQuery.data ?? []).find((policy) => policy.policyVersionId === effectivePolicyVersionId)
            ?? (activePolicyQuery.data?.policyVersionId === effectivePolicyVersionId ? activePolicyQuery.data ?? null : null)} />
        <Button variant="outline" size="sm" onClick={handleUndo} disabled={!undoStack.canUndo}>
          {he.action.undo}
        </Button>
        <BoardPublicationActions departmentId={departmentId} weekStart={weekStart} />
      </div>

      {conflictCount > 0 ? (
        <button type="button" onClick={jumpToNextConflict} title={he.sadranBoard.nextConflict}
          className="w-full rounded-md border border-destructive/40 bg-destructive/5 p-2 text-start text-sm text-destructive hover:bg-destructive/10 focus-visible:outline focus-visible:outline-2 focus-visible:outline-destructive">
          {tv("sadranBoard.conflictBanner", { count: String(conflictCount) })}
          <span className="ms-2 text-xs">{he.sadranBoard.nextConflict}</span>
          {focusedConflict ? <span aria-live="polite" className="mt-1 block font-semibold">{tv("sadranBoard.conflictLocation", {
            index: String(focusedConflictIndex + 1), count: String(conflictCount),
            day: weekdayLabel(focusedConflict.starts_at),
            date: formatInTimeZone(focusedConflict.starts_at, TZ, "d/M/yyyy"),
            time: `${formatTime(new Date(focusedConflict.starts_at))}–${formatTime(new Date(focusedConflict.ends_at))}`,
            car: carsQuery.data?.find((car) => car.id === focusedConflict.car_id)?.name ?? "",
          })}</span> : null}
        </button>
      ) : null}

      <div className="flex items-center justify-between gap-2">
        <WeekStrip weekStart={weekStart} counts={dayCounts} selected={selectedDay} onSelect={setSelectedDay} />
        <Button variant="ghost" size="sm" className={tableView ? "shrink-0" : "hidden shrink-0 lg:inline-flex"} onClick={() => setShowEarlyHours((v) => !v)}>
          {showEarlyHours ? he.board.hideEarlyHours : he.board.showEarlyHours}
        </Button>
      </div>

      <RideTypeLegend types={(rideTypesQuery.data ?? []).map((rt) => ({ code: rt.code, nameHe: rt.name_he }))} />

      <TableViewControls table={tableView} onTableChange={setTableView} zoom={tableZoom} onZoomChange={setTableZoom} />
      <div className="grid gap-3 lg:grid-cols-[minmax(0,1fr)_340px]">
        <div className={tableView ? "min-w-0" : "hidden min-w-0 lg:block"}>
          <WeekGrid
            zoom={tableZoom}
            cars={weekGridCars}
            rides={weekGridRides}
            blocks={weekGridBlocks}
            dayStartMinutes={dayStartMinutes}
            dayEndMinutes={dayEndMinutes}
            readOnly={false}
            draggable
            canDragRide={(ride) => !ride.id.startsWith("merge:") && (!ride.id.startsWith("change:") || !!(rideChangesQuery.data ?? []).find((change) => change.is_planning && `change:${change.id}` === ride.id))}
            canResizeRide={(ride) => !ride.id.startsWith("request:") && !ride.id.startsWith("change:") && !ride.id.startsWith("merge:")}
            onSlotClick={(carId, minutes) => !carId.startsWith("phantom:") && setReservation({ carId, start: formatMinutes(minutes), end: formatMinutes(Math.min(1439, minutes + 60)), notes: "" })}
            onRideClick={handleRideClick}
            onRideDrop={(rideId, carId, minutes, droppedOnRideId) => void handleRideDrop(rideId, carId, minutes, droppedOnRideId)}
            onRideResize={handleRideResize}
            isDropTargetValid={isDropTargetValid}
            resolveDropPreview={(ride, carId, startMinutes, endMinutes, hostRideId) => {
              const item = unmetItems.find((item) => `request:${item.request.id}` === ride.id);
              if (carId.startsWith("phantom:")) return { startMinutes, endMinutes };
              const window = item ? unmetPreviewWindow(item, carId, startMinutes, hostRideId)
                : mergeCandidateForRide(ride.id, carId, minutesIso(startMinutes), minutesIso(endMinutes), hostRideId)?.window;
              return window ? { startMinutes: (Date.parse(window.startsAt) - Date.parse(dayStartIso(selectedDay))) / 60_000,
                endMinutes: (Date.parse(window.endsAt) - Date.parse(dayStartIso(selectedDay))) / 60_000 } : { startMinutes, endMinutes };
            }}
            externalDropTarget={
              unmetDragHover
                ? {
                    carId: unmetDragHover.carId,
                    startMinutes: unmetPreview ? (Date.parse(unmetPreview.startsAt) - Date.parse(dayStartIso(selectedDay))) / 60_000 : unmetDragHover.minutes,
                    endMinutes: unmetPreview ? (Date.parse(unmetPreview.endsAt) - Date.parse(dayStartIso(selectedDay))) / 60_000 : unmetDragHover.minutes + 30,
                    label: `${unmetDragHover.item.request.requester_full_name ?? ""} · ${unmetDragHover.item.destinationName}`,
                    valid: isUnmetDropValid(unmetDragHover.item, unmetDragHover.carId, unmetDragHover.minutes, unmetDragHover.hostRideId),
                  }
                : null
            }
            onRideDropOnUnmet={(rideId) => void handleUnassignRide(rideId)}
            discussionBlocks={weekGridDiscussionBlocks}
            onDiscussionClick={setSelectedGroupId}
          />
        </div>

        <div className={tableView ? "hidden" : "lg:hidden"}>
          {dayWaitlistGroups.length ? (
            <div className="mb-2 space-y-2">
              {dayWaitlistGroups.map((group) => (
                <WaitlistGroupCard key={group.id} group={group} onClick={() => setSelectedGroupId(group.id)} />
              ))}
            </div>
          ) : null}
          <BoardListMode
            key={conflictJump?.sequence ?? 0}
            shadowedRideIds={shadowedRideIds}
            pendingRides={pendingMerges.filter((merge) => dateKey(merge.startsAt) === selectedDay).map((merge) => ({
              id: `merge:${merge.proposal.id}`, startsAt: merge.startsAt, endsAt: merge.endsAt,
              originName: merge.host.origin_name ?? "", destinationName: weekGridRides.find((ride) => ride.id === `merge:${merge.proposal.id}`)?.label ?? "",
              driverName: merge.host.driver_name, carName: (carsQuery.data ?? []).find((car) => car.id === merge.host.car_id)?.name ?? null,
            }))}
            rides={[...activeDayRides, ...planningRows.filter((ride) => dateKey(ride.starts_at) === selectedDay)]
              .filter((r) => r.id && r.starts_at)
              .map((r) => ({
                id: r.id as string,
                startsAt: r.starts_at as string,
                endsAt: r.ends_at,
                originName: r.origin_name ?? "",
                // Same fix as the grid's `rideBlockLabel` (bug #3): a round
                // trip's own `destination_name` is always home ("נבו").
                description: [servedOf(r).length ? r.notes : null, ridePublicDetails(withChildNames(servedOf(r), requestsQuery.data ?? []), { includeCompanions: false })].filter(Boolean).join("\n"),
                passengerSummary: ridePassengerSummary(withChildNames(servedOf(r), requestsQuery.data ?? []), r.needs_driver ? null : r.driver_name),
                coordinatorNotes: rideCoordinatorNotes(servedOf(r), requestsQuery.data ?? []),
                label: weekGridRides.find((item) => item.id === r.id)?.label,
                destinationName: (
                  department?.home_destination_id && r.origin_id && r.destination_id
                    ? resolveRideRealDestination({
                        originId: r.origin_id,
                        destinationId: r.destination_id,
                        originName: r.origin_name ?? "",
                        destinationName: r.destination_name ?? "",
                        homeDestinationId: department.home_destination_id,
                        served: servedOf(r),
                      })
                    : (r.destination_name ?? "")),
                driverName: r.driver_name,
                needsDriver: !!r.needs_driver,
                conflict: conflictRideIds.has(r.id as string),
                highlighted: focusedConflict?.id === r.id,
                tightSchedule: tightRideIds.has(r.id as string),
                isChauffeur: !!r.is_chauffeur,
                carName: (carsQuery.data ?? []).find((c) => c.id === r.car_id)?.name ?? null,
                carType: (carsQuery.data ?? []).find((c) => c.id === r.car_id)?.type,
                rideTypeCode: representativeRideTypeCode(servedOf(r)),
              }))}
            onRideClick={handleRideClick}
            unmetItems={unmetItems}
            onUnmetAction={handleUnmetAction}
            onUnmetDecision={handleUnmetDecision}
            onOpenProposals={() => navigate(paths.sadran.proposals(departmentId, weekStart))}
            pendingProposalsCount={(proposalsQuery.data ?? []).filter((p) => p.status === "sent").length}
          />

        </div>

        <div
          className={tableView ? "min-w-0" : "hidden min-w-0 lg:block"}
          {...{ [UNMET_DROP_ZONE_ATTR]: "true" }}
        >
          <h2 className="mb-2 font-semibold">{tv("sadranBoard.unmetTitle", { count: String(unmetItems.length) })}</h2>
          {unmetItems.length === 0 ? (
            <EmptyState icon={CalendarDays} message={he.sadranBoard.noSuggestions} />
          ) : (
            <UnmetList
              items={unmetItems}
              onAction={handleUnmetAction}
              onDecision={handleUnmetDecision}
              dayStartMinutes={dayStartMinutes}
              dayEndMinutes={dayEndMinutes}
              onDragHover={(item, carId, minutes, hostRideId) => setUnmetDragHover(carId && minutes != null ? { item, carId, minutes, hostRideId } : null)}
              onDragDrop={(item, carId, minutes, hostRideId) => void handlePlaceUnmetRequest(item, carId, minutes, hostRideId)}
              // The `<h2>` right above already renders this exact title — avoid duplicating it.
              showHeading={false}
            />
          )}
        </div>
      </div>

      <Dialog open={!!mergePrefill} onOpenChange={(open) => !open && setMergePrefill(null)}>
        <DialogContent><DialogHeader><DialogTitle>{he.boardCoordination.mergeTitle}</DialogTitle><DialogDescription>{he.boardCoordination.mergeHelp}</DialogDescription></DialogHeader>
          {mergePrefill ? <div className="space-y-2 rounded-md border p-3 text-sm">
            <p>{weekGridRides.find((ride) => ride.id === mergePrefill.rideId)?.label}</p>
            <p>{(requestsQuery.data ?? []).find((request) => request.id === mergePrefill.requestId)?.requester_full_name} · {(requestsQuery.data ?? []).find((request) => request.id === mergePrefill.requestId)?.destination_resolved_name}</p>
            {typeof mergePrefill.payload.starts_at === "string" && typeof mergePrefill.payload.ends_at === "string" ? <p>{he.boardCoordination.expandedWindow} · <strong dir="ltr">{formatTime(new Date(mergePrefill.payload.starts_at))}–{formatTime(new Date(mergePrefill.payload.ends_at))}</strong></p> : null}
          </div> : null}
          <Button onClick={() => { if (mergePrefill) goToComposer(mergePrefill); setMergePrefill(null); }}>{he.sadranBoard.prepareMerge}</Button>
          <Button variant="outline" onClick={() => setMergePrefill(null)}>{he.common.cancel}</Button>
        </DialogContent>
      </Dialog>
      <Sheet open={!!selectedUnmet} onOpenChange={(open) => !open && setSelectedUnmetId(null)}>
        <SheetContent side="bottom"><SheetHeader><SheetTitle>{he.board.unmet}</SheetTitle></SheetHeader>
          {selectedUnmet ? <UnmetList items={[selectedUnmet]} onAction={handleUnmetAction} onDecision={handleUnmetDecision} /> : null}
        </SheetContent>
      </Sheet>

      <WaitlistGroupSheet
        group={selectedWaitlistGroup}
        departmentId={departmentId}
        weekStart={weekStart}
        profileId={undefined}
        canManageWeek
        onOpenChange={(open) => !open && setSelectedGroupId(null)}
      />
      <Dialog open={!!reservation} onOpenChange={(open) => !open && setReservation(null)}>
        <PortalDialogContent><DialogHeader><DialogTitle>{he.sadranBoard.reservation}</DialogTitle><DialogDescription>{selectedDay}</DialogDescription></DialogHeader>
          {reservation ? <>
            <Select value={reservation.carId} onValueChange={(carId) => setReservation({ ...reservation, carId })}><SelectTrigger><SelectValue /></SelectTrigger><SelectContent>{(carsQuery.data ?? []).map((car) => <SelectItem key={car.id} value={car.id}>{car.name}</SelectItem>)}</SelectContent></Select>
            <div className="flex gap-2"><TimeField15 min="00:00" aria-label={he.sadranRideSheet.depart} value={reservation.start} onChange={(start) => setReservation({ ...reservation, start })} /><TimeField15 min="00:00" max="23:59" aria-label={he.sadranRideSheet.return} value={reservation.end} onChange={(end) => setReservation({ ...reservation, end })} /></div>
            <Textarea aria-label={he.sadranBoard.reservationNotes} placeholder={he.sadranBoard.reservationNotes} value={reservation.notes} onChange={(event) => setReservation({ ...reservation, notes: event.target.value })} />
            <Button disabled={editRideMutation.isPending || !reservation.notes.trim() || !reservation.carId} onClick={() => void saveReservation()}>{he.common.save}</Button>
          </> : null}
        </PortalDialogContent>
      </Dialog>
      <RideSheet
        key={selectedPlanningChange?.id ?? selectedRide?.id ?? "no-ride"}
        ride={selectedRide && selectedPlanningChange ? { ...selectedRide, car_id: selectedPlanningChange.car_id, starts_at: selectedPlanningChange.starts_at, ends_at: selectedPlanningChange.ends_at } : selectedRide}
        isPlanning={!!selectedPlanningChange}
        coordinatorNotes={selectedRide ? rideCoordinatorNotes(servedOf(selectedRide), requestsQuery.data ?? []) : undefined}
        requests={requestsQuery.data ?? []}
        cars={carsQuery.data ?? []}
        driverName={selectedRideDriverName}
        homeDestinationId={department?.home_destination_id ?? null}
        onOpenChange={(open) => !open && setSelectedRideId(null)}
        saving={editRideMutation.isPending || claimDriverMutation.isPending}
        tightSchedule={!!selectedRide?.id && tightRideIds.has(selectedRide.id)}
        onClaimDriver={() => {
          if (!selectedRide?.id || selectedRide.version == null) return;
          claimDriverMutation.mutate({ rideId: selectedRide.id, expectedVersion: selectedRide.version }, { onSuccess: () => toast.success(he.boardCoordination.driverClaimed) });
        }}
        onSave={(input) => {
          if (!selectedRide?.id || !selectedRide.origin_id || !selectedRide.destination_id) return;
          if (Date.parse(input.endsAt) <= Date.parse(input.startsAt)) { toast.error(he.sadranBoard.invalidWindow); return; }
          const hasCollision = rides.some((other) => other.id !== selectedRide.id && other.car_id === input.carId && other.starts_at && other.ends_at
            && Date.parse(other.starts_at) < Date.parse(input.endsAt) && Date.parse(input.startsAt) < Date.parse(other.ends_at));
          const outsideFlex = servedOf(selectedRide).map((entry) => (requestsQuery.data ?? []).find((req) => req.id === entry.request_id))
            .find((req) => req && !requestWithinFlex(req, input.startsAt, input.endsAt));
          if (outsideFlex && !(hasCollision && selectedRide.status !== "draft")) {
            goToComposer({ requestId: outsideFlex.id, rideId: selectedRide.id, type: "shift", payload: { car_id: input.carId, depart_at: input.startsAt, return_at: input.endsAt, origin_id: selectedRide.origin_id, destination_id: selectedRide.destination_id, ride_id: selectedRide.id } });
            return;
          }
          // Same conflict checks as the drag path (bug #2: "checked and
          // reported in Hebrew" applies to the no-drag car-select fallback
          // too, not only dragging) — without this, picking an already-
          // occupied car raised a raw, untranslated Postgres exclusion-
          // constraint error (`rides_no_overlap_per_car`) and, because nothing
          // downstream of this `mutateAsync` call caught the rejection, the
          // sheet was left stuck open with no clear feedback (reproduced
          // directly; `e2e/board.spec.ts`'s car-selector test caught it).
          if (input.carId !== selectedRide.car_id && !seatsFit(input.carId, passengersOf(selectedRide))) {
            toast.error(he.sadranBoard.seatMismatchToast);
            return;
          }
          void editRideMutation
            .mutateAsync({
              input: {
                id: selectedRide.id,
                department_id: departmentId,
                week_start: weekStart,
                car_id: input.carId,
                starts_at: input.startsAt,
                ends_at: input.endsAt,
                origin_id: selectedRide.origin_id,
                destination_id: selectedRide.destination_id,
                driver_id: selectedRide.driver_id,
                needs_driver: !!selectedRide.needs_driver,
                allow_conflict: true,
                notes: selectedRide.notes,
                overnight_ack: input.overnightAck,
                // Manual save (including a plain car change via the sheet's
                // select, the no-drag fallback bug #2 asks for) auto-pins,
                // same reasoning as the drag path above.
                is_pinned: true,
                pin_reason: selectedRide.pin_reason ?? "SADRAN_MANUAL",
                served: servedToEditRideLegs(servedOf(selectedRide)),
              },
              expectedVersion: selectedPlanningChange?.expected_version ?? selectedRide.version ?? undefined,
              departmentId,
              weekStart,
            })
            .then(() => { if (hasCollision && selectedRide.status !== "draft") toast.success(he.boardCoordination.planningSaved); setSelectedRideId(null); })
            .catch(() => {
              // Toast already shown by the mutation's onError; keep the
              // sheet open (not closed) so the Sadran can adjust and retry,
              // and don't leave an unhandled rejection behind.
            });
        }}
        onTogglePin={(nextPinned, reason) => {
          if (!selectedRide?.id || !selectedRide.car_id || !selectedRide.origin_id || !selectedRide.destination_id) return;
          void editRideMutation.mutateAsync({
            input: {
              id: selectedRide.id,
              department_id: departmentId,
              week_start: weekStart,
              car_id: selectedRide.car_id,
              starts_at: selectedRide.starts_at as string,
              ends_at: selectedRide.ends_at as string,
              origin_id: selectedRide.origin_id,
              destination_id: selectedRide.destination_id,
              driver_id: selectedRide.driver_id,
                notes: selectedRide.notes ?? undefined,
              is_pinned: nextPinned,
              pin_reason: reason,
              served: servedToEditRideLegs(servedOf(selectedRide)),
            },
            expectedVersion: selectedRide.version ?? undefined,
            departmentId,
            weekStart,
          });
        }}
        onCancel={(reason) => {
          if (selectedPlanningChange) { cancelRideChangeMutation.mutate(selectedPlanningChange.id, { onSuccess: () => setSelectedRideId(null) }); return; }
          if (!selectedRide?.id) return;
          void cancelRideMutation
            .mutateAsync({ rideId: selectedRide.id, reason, expectedVersion: selectedRide.version ?? undefined, departmentId, weekStart })
            .then(() => setSelectedRideId(null))
            .catch(() => {
              // Toast already shown by the mutation's onError; same reasoning as `onSave` above.
            });
        }}
        onUnassign={() => {
          if (!selectedRide?.id) return;
          void handleUnassignRide(selectedRide.id).then(() => setSelectedRideId(null));
        }}
      />
    </div>
  );
}
