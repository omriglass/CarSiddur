import { formatInTimeZone, fromZonedTime } from "date-fns-tz";
import { useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { toast } from "sonner";
import { useQuery } from "@tanstack/react-query";

import { datesOfWeek, formatWeekRangeLabel, todayInJerusalem } from "@/components/DateField";
import { EmptyState } from "@/components/EmptyState";
import { ErrorState } from "@/components/ErrorState";
import { PageHeader } from "@/components/PageHeader";
import { formatMinutes } from "@/components/TimeField15";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { TimeField15, parseHHMM } from "@/components/TimeField15";
import { Textarea } from "@/components/ui/textarea";
import { packPhantomLanes, requestStart, requestWindow, requestWithinFlex } from "../phantomLanes";
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
import { UNMET_DROP_ZONE_ATTR, WeekGrid, type WeekGridBlock, type WeekGridCar, type WeekGridRide } from "@/components/WeekGrid";
import { WeekStrip } from "@/components/WeekStrip";
import { parseTimeToMinutes } from "@/features/solverBridge/buildSolverInput";
import { CalendarDays } from "lucide-react";
import { fetchCarSeatConfigs } from "@/features/fleet/api";
import { useRideTypes } from "@/features/fleet/hooks";
import { RideTypeLegend } from "@/components/RideTypeLegend";
import { BoardGridSkeleton } from "@/components/skeletons/BoardGridSkeleton";
import { useCarLocations, useDepartments, useRideChanges } from "@/features/siddur/hooks";
import { he, tv } from "@/i18n/he";
import { TZ } from "@/lib/time";

import { scanBoardConflicts, wouldOverlap, requestDayMismatchRideIds } from "../geometry";
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
} from "../../solverRun";
import { useUndoStack } from "../useUndoStack";
import { BoardListMode } from "./BoardListMode";
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

  const carsQuery = useCarsForDepartment(departmentId);
  const carLocationsQuery = useCarLocations(departmentId, weekStart);
  const rideTypesQuery = useRideTypes();
  const maintenanceQuery = useMaintenanceBlocks(departmentId);
  const requestsQuery = useWeekRequestsWithNames(departmentId, weekStart);
  const ridesQuery = useAllWeekRides(departmentId, weekStart);
  const rideChangesQuery = useRideChanges(departmentId, weekStart);
  const proposalsQuery = useProposalsForWeek(departmentId, weekStart);
  const departmentSettingsQuery = useDepartmentSettings(departmentId);
  const activePolicyQuery = useActivePolicy(departmentId);
  const policyOptionsQuery = usePolicyOptions(departmentId);
  const seatConfigsQuery = useQuery({
    queryKey: ["sadran", departmentId, "seatConfigs"],
    queryFn: () => fetchCarSeatConfigs(departmentId),
    enabled: !!departmentId,
    staleTime: 60_000,
  });

  const editRideMutation = useEditRideMutation();
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
  // 06:00–24:00 by default"): `department_settings.board_start_time` (an
  // existing column, previously unused for display) is the default start
  // when set, else 06:00; "הצג שעות מוקדמות" expands down to 00:00.
  const [showEarlyHours, setShowEarlyHours] = useState(false);
  const boardStartMinutes = departmentSettingsQuery.data?.board_start_time
    ? parseTimeToMinutes(departmentSettingsQuery.data.board_start_time)
    : 6 * 60;
  const dayStartMinutes = showEarlyHours ? 0 : boardStartMinutes;
  const dayEndMinutes = 24 * 60;

  // Drag-an-unmet-card-onto-a-car-column (UX_FLOWS §20 item 3): live hover
  // state reported by `UnmetList`'s own pointer tracking (it owns the
  // gesture since the drag starts on its cards, outside the grid) — the
  // grid only needs to know which car to highlight and whether the drop
  // would be valid right now.
  const [unmetDragHover, setUnmetDragHover] = useState<{ item: UnmetListItem; carId: string; minutes: number } | null>(null);
  /** Collapsible bottom drawer for the md–lg gap (UX_FLOWS §20) — the side panel only shows at `lg:`. */
  const [unmetDrawerOpen, setUnmetDrawerOpen] = useState(false);

  function computeDefaultDay(): string {
    if (days.includes(today)) return today;
    const activityByDay = new Map(days.map((d) => [d, 0]));
    for (const r of ridesQuery.data ?? []) {
      if (!r.starts_at) continue;
      const d = formatInTimeZone(new Date(r.starts_at), TZ, "yyyy-MM-dd");
      if (activityByDay.has(d)) activityByDay.set(d, (activityByDay.get(d) ?? 0) + 1);
    }
    for (const r of requestsQuery.data ?? []) {
      if (!isUnmetStatus(r.status) || !requestStart(r)) continue;
      const d = formatInTimeZone(new Date(requestStart(r)!), TZ, "yyyy-MM-dd");
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
  const [policyVersionOverride, setPolicyVersionOverride] = useState<string | null>(null);
  const [preview, setPreview] = useState<{ output: SolverOutput; policyVersionId: string } | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);

  const effectivePolicyVersionId = policyVersionOverride ?? activePolicyQuery.data?.policyVersionId ?? null;

  /**
   * Populates the unmet list's per-request score/suggestions by running the
   * pure solver client-side (SOLVER.md §2), without persisting anything —
   * triggered by "הרץ פותר" (a click handler, not an effect: this board
   * deliberately does not auto-run on mount, unlike the dashboard's result
   * sheet flow, to keep every solver invocation an explicit Sadran action;
   * see the stage 2b report).
   *
   * MAJOR BUG fix (docs/UX_FLOWS.md §19): this board's own apply action is
   * only "▶ השלם אוטומטית" below, always `'remaining'` mode — a full
   * re-solve of the whole week (`mode: 'full'`, `computeFullResolveDiff`'s
   * confirm dialog) is wired on the dashboard instead
   * (`WeekDashboardScreen.tsx`'s "פתור מחדש את כל השבוע", next to its
   * primary "הרץ פותר"), not duplicated here. Previewing in `'full'` mode
   * here used to forecast a solve the board could never actually apply (and,
   * before the root-cause fix in `applySolve.ts`, under-reported unmet
   * requests whose ride was an unpinned solver draft — exactly the requests
   * that were disappearing). Matching the preview's mode to the only apply
   * path this screen offers keeps what the Sadran sees in sync with what a
   * click on "השלם אוטומטית" will actually do.
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
  const activeDayRides = rides.filter(
    (r) => r.starts_at && formatInTimeZone(new Date(r.starts_at), TZ, "yyyy-MM-dd") === selectedDay,
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
            })),
            carIds: [...new Set(validRides.map((r) => r.car_id))],
            weekStartMs,
            bufferMinutes: daySettings.turnaround_minutes,
            homeLocationId: department.home_destination_id,
            days: days96,
          });
        })()
      : null;

  const conflictRideIds = new Set([
    ...(conflictScan?.conflictRideIds ?? []),
    ...requestDayMismatchRideIds(rides, requestsQuery.data ?? []),
  ]);

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

  const shadowedRideIds = new Set((rideChangesQuery.data ?? []).flatMap((change) => [change.ride_id, ...change.parties.map((party) => party.ride_id)]));
  const weekGridRides: WeekGridRide[] = activeDayRides
    .filter((r) => r.id && r.car_id && r.starts_at && r.ends_at)
    .map((r) => ({
      id: r.id as string,
      carId: r.car_id as string,
      startMinutes: Math.round((Date.parse(r.starts_at as string) - Date.parse(dayStartIso(selectedDay))) / 60_000),
      endMinutes: Math.round((Date.parse(r.ends_at as string) - Date.parse(dayStartIso(selectedDay))) / 60_000),
      // Owner bug report #3: a round-trip ride is stored as one row with
      // origin_id === destination_id === the department's home location
      // (DATA_MODEL.md consistency decision #14), so `r.destination_name`
      // alone is always the department's own name ("נבו") for the common
      // case — `rideBlockLabel` composes "<driver> ו<passengers> ל<real
      // destination>" from `served` instead (see `rideLabel.ts`).
      label: r.notes || (
        department?.home_destination_id && r.origin_id && r.destination_id
          ? rideBlockLabel({
              originId: r.origin_id,
              destinationId: r.destination_id,
              originName: r.origin_name ?? "",
              destinationName: r.destination_name ?? "",
              homeDestinationId: department.home_destination_id,
              served: servedOf(r),
            })
          : (r.destination_name ?? "")),
      pinned: !!r.is_pinned,
      shadowed: shadowedRideIds.has(r.id as string),
      conflict: conflictRideIds.has(r.id as string),
      pendingConsent: pendingConsentRideIds.has(r.id as string),
      rideTypeCode: representativeRideTypeCode(servedOf(r)),
    }));

  for (const change of rideChangesQuery.data ?? []) {
    if (formatInTimeZone(change.starts_at, TZ, "yyyy-MM-dd") !== selectedDay) continue;
    const original = weekGridRides.find((ride) => ride.id === change.ride_id);
    weekGridRides.push({ id: `change:${change.id}`, carId: change.car_id,
      startMinutes: (Date.parse(change.starts_at) - Date.parse(dayStartIso(selectedDay))) / 60_000,
      endMinutes: (Date.parse(change.ends_at) - Date.parse(dayStartIso(selectedDay))) / 60_000,
      label: `${original?.label ?? change.requester?.full_name ?? ""} · ${he.rideEditing.pending}`, pendingConsent: true, rideTypeCode: original?.rideTypeCode });
  }

  const weekGridBlocks: WeekGridBlock[] = (maintenanceQuery.data ?? []).flatMap((block) => {
    const startMinutes = (Date.parse(block.starts_at) - Date.parse(dayStartIso(selectedDay))) / 60_000;
    const endMinutes = (Date.parse(block.ends_at) - Date.parse(dayStartIso(selectedDay))) / 60_000;
    return startMinutes < 1440 && endMinutes > 0 ? [{ id: block.id, carId: block.car_id, startMinutes, endMinutes }] : [];
  });

  const dayCounts = days.map((d) => ({
    rides: rides.filter((r) => r.starts_at && formatInTimeZone(new Date(r.starts_at), TZ, "yyyy-MM-dd") === d).length,
    unmet: (requestsQuery.data ?? []).filter(
      (r) => isUnmetStatus(r.status) && requestStart(r) && formatInTimeZone(new Date(requestStart(r)!), TZ, "yyyy-MM-dd") === d,
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
    .filter((r) => isUnmetStatus(r.status) && requestStart(r) && formatInTimeZone(new Date(requestStart(r)!), TZ, "yyyy-MM-dd") === selectedDay)
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
      label: `${item.request.requester_full_name ?? ""} · ${item.destinationName}`, rideTypeCode: item.request.ride_type_code }];
  }));
  for (let lane = 0; lane <= Math.max(-1, ...phantomRides.map((ride) => ride.lane)); lane++) {
    weekGridCars.push({ id: `phantom:${lane}`, name: tv("sadranBoard.phantomCar", { number: String(lane + 1) }), group: "phantom" });
  }
  weekGridCars.push({ id: "phantom:unassign", name: he.sadranBoard.unassignLane, group: "phantom" });
  weekGridRides.push(...phantomRides.map((ride) => ({ ...ride, carId: `phantom:${ride.lane}`, pendingConsent: true })));
  const selectedUnmet = unmetItems.find((item) => item.request.id === selectedUnmetId);

  const selectedRide = rides.find((r) => r.id === selectedRideId) ?? null;
  const selectedRideDriverName = selectedRide?.driver_name ?? null;

  const seatConfigsByCarId = new Map<string, { adults: number; child_seats: number; boosters: number }[]>();
  for (const sc of seatConfigsQuery.data ?? []) {
    const list = seatConfigsByCarId.get(sc.car_id) ?? [];
    list.push({ adults: sc.adults, child_seats: sc.child_seats, boosters: sc.boosters });
    seatConfigsByCarId.set(sc.car_id, list);
  }

  function passengersOf(ride: (typeof rides)[number]) {
    return servedOf(ride).reduce(
      (acc, s) => ({ adults: acc.adults + s.adults, childSeats: acc.childSeats + s.child_seats, boosters: acc.boosters + s.boosters }),
      { adults: 0, childSeats: 0, boosters: 0 },
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

  /** Validate the live preview window, including phantom requests dragged into real cars. */
  function isDropTargetValid(rideId: string, carId: string, startMinutes: number, endMinutes: number): boolean {
    if (carId.startsWith("phantom:")) return !rideId.startsWith("request:");
    if (rideId.startsWith("request:")) {
      const item = unmetItems.find((item) => `request:${item.request.id}` === rideId);
      return !!item && isUnmetDropValid(item, carId, startMinutes);
    }
    if (startMinutes < 0 || endMinutes > 1440 || endMinutes <= startMinutes || unavailable(carId, minutesIso(startMinutes), minutesIso(endMinutes))) return false;
    const ride = rides.find((r) => r.id === rideId);
    if (!ride?.starts_at || !ride.ends_at) return true;
    if (!seatsFit(carId, passengersOf(ride))) return false;
    const others = rides
      .filter((r) => r.id !== rideId && r.car_id === carId && r.starts_at && r.ends_at)
      .map((r) => ({ startsAt: r.starts_at as string, endsAt: r.ends_at as string }));
    return !wouldOverlap({ startsAt: minutesIso(startMinutes), endsAt: minutesIso(endMinutes) }, others, daySettings?.turnaround_minutes ?? 30);
  }

  function unmetRequestPassengers(r: WeekRequestRow) {
    return { adults: r.adults, childSeats: r.child_seats, boosters: r.boosters };
  }

  /** Shared timestamp conversion for the current day and snapped preview/drop windows. */
  function minutesIso(minutes: number): string {
    const date = new Date(`${selectedDay}T12:00:00Z`);
    date.setUTCDate(date.getUTCDate() + Math.floor(minutes / 1440));
    const time = formatMinutes(((minutes % 1440) + 1440) % 1440);
    return fromZonedTime(`${date.toISOString().slice(0, 10)}T${time}:00`, TZ).toISOString();
  }

  function unmetCandidateWindow(item: UnmetListItem, minutes: number): { startsAt: string; endsAt: string } | null {
    const req = item.request;
    const original = requestWindow(req);
    if (!original || !requestStart(req) || formatInTimeZone(new Date(requestStart(req)!), TZ, "yyyy-MM-dd") !== selectedDay) return null;
    const duration = (Date.parse(original.endsAt) - Date.parse(original.startsAt)) / 60_000;
    if (minutes < 0 || minutes + duration > 1440) return null;
    return { startsAt: minutesIso(minutes), endsAt: minutesIso(minutes + duration) };
  }

  /** Live drag feedback for an unmet card hovering a car column — same seat-fit/overlap checks as `isDropTargetValid` above. */
  function isUnmetDropValid(item: UnmetListItem, carId: string, minutes: number): boolean {
    const window = unmetCandidateWindow(item, minutes);
    if (!window || carId.startsWith("phantom:") || unavailable(carId, window.startsAt, window.endsAt)) return false;
    if (item.request.trip_shape !== "round_trip" && item.request.one_way_car_mode !== "relay") {
      return rides.some((host) => host.car_id === carId && host.starts_at && host.ends_at
        && Date.parse(host.starts_at) < Date.parse(window.endsAt) && Date.parse(window.startsAt) < Date.parse(host.ends_at)
        && seatsFit(carId, { adults: passengersOf(host).adults + item.request.adults, childSeats: passengersOf(host).childSeats + item.request.child_seats, boosters: passengersOf(host).boosters + item.request.boosters }));
    }
    if (!seatsFit(carId, unmetRequestPassengers(item.request))) return false;
    const others = rides
      .filter((r) => r.car_id === carId && r.starts_at && r.ends_at)
      .map((r) => ({ startsAt: r.starts_at as string, endsAt: r.ends_at as string }));
    return !wouldOverlap(window, others, daySettings?.turnaround_minutes ?? 30);
  }

  /** Assign a request leg or prepare a proposal when sharing/relay coordination is required. */
  async function handlePlaceUnmetRequest(item: UnmetListItem, carId: string, minutes: number) {
    setUnmetDragHover(null);
    const req = item.request;
    if (carId.startsWith("phantom:")) return;
    if (!requestStart(req) || formatInTimeZone(new Date(requestStart(req)!), TZ, "yyyy-MM-dd") !== selectedDay) {
      toast.error(he.sadranBoard.wrongDay); return;
    }
    const window = unmetCandidateWindow(item, minutes);
    if (!window || !department?.home_destination_id) {
      toast.error(he.sadranBoard.invalidWindow);
      return;
    }
    if (req.trip_shape !== "round_trip" && req.one_way_car_mode !== "relay") {
      const host = rides.find((ride) => ride.car_id === carId && ride.starts_at && ride.ends_at
        && Date.parse(ride.starts_at) < Date.parse(window.endsAt) && Date.parse(window.startsAt) < Date.parse(ride.ends_at));
      if (host?.id) {
        setMergePrefill({ requestId: req.id, rideId: host.id, type: "merge", payload: { ride_id: host.id,
          legs: [{ ride_id: host.id, role: "passenger", leg: req.trip_shape === "one_way_from" ? "return" : "out", car_mode: "passenger" }] } });
      } else {
        toast(he.sadranBoard.passengerNeedsHost);
        goToComposer({ requestId: req.id, rideId: null, type: "external", payload: { hint: "cab" } });
      }
      return;
    }
    if (req.trip_shape !== "round_trip" && !req.destination_id) {
      goToComposer({ requestId: req.id, rideId: null, type: "external", payload: { hint: "cab" } });
      return;
    }
    if (unavailable(carId, window.startsAt, window.endsAt)) { toast.error(he.sadranBoard.maintenanceUnavailable); return; }
    if (!seatsFit(carId, unmetRequestPassengers(req))) {
      toast.error(he.sadranBoard.dragInvalidSeatsToast);
      return;
    }
    const others = rides
      .filter((r) => r.car_id === carId && r.starts_at && r.ends_at)
      .map((r) => ({ startsAt: r.starts_at as string, endsAt: r.ends_at as string }));
    if (wouldOverlap(window, others, daySettings?.turnaround_minutes ?? 30)) {
      toast.error(he.sadranBoard.dragInvalidOverlapToast);
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
          origin_id: req.trip_shape === "one_way_from" ? req.destination_id! : department.home_destination_id,
          destination_id: req.trip_shape === "one_way_to" ? req.destination_id! : department.home_destination_id,
          driver_id: req.requester_id,
          is_pinned: true,
          pin_reason: "SADRAN_MANUAL",
          served: [{ request_id: req.id, role: "driver", leg: req.trip_shape === "round_trip" ? "both" : req.trip_shape === "one_way_from" ? "return" : "out", car_mode: req.trip_shape === "round_trip" ? "keep" : "relay" }],
        },
        departmentId,
        weekStart,
      });
      const carName = (carsQuery.data ?? []).find((c) => c.id === carId)?.name ?? "";
      toast.success(tv("sadranBoard.dragPlacedToast", { car: carName, start: formatMinutes(minutes) }));
    } catch {
      // A relay requires a compatible car-location chain. Keep the requested
      // placement reviewable when a direct assignment cannot satisfy it.
      if (req.trip_shape !== "round_trip") {
        toast(he.sadranBoard.relayNeedsCoordination);
        goToComposer({ requestId: req.id, rideId: null, type: "shift", payload: req.trip_shape === "one_way_from" ? { return_at: window.endsAt } : { depart_at: window.startsAt } });
      }
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
  }) {
    navigate(`/sadran/${departmentId}/${weekStart}/proposals/new`, { state: prefill });
  }


  async function handleRideDrop(rideId: string, carId: string, startMinutes: number, droppedOnRideId?: string, resizedEndMinutes?: number) {
    if (rideId.startsWith("request:")) {
      const item = unmetItems.find((item) => `request:${item.request.id}` === rideId);
      if (item) await handlePlaceUnmetRequest(item, carId, startMinutes);
      return;
    }
    if (carId.startsWith("phantom:")) { await handleUnassignRide(rideId); return; }
    const ride = rides.find((r) => r.id === rideId);
    if (!ride?.id || !ride.starts_at || !ride.ends_at || !ride.car_id || !ride.origin_id || !ride.destination_id) return;

    const candidateEnd = resizedEndMinutes ?? startMinutes + (Date.parse(ride.ends_at) - Date.parse(ride.starts_at)) / 60_000;
    const collision = rides.find((other) => other.id !== rideId && other.car_id === carId && other.starts_at && other.ends_at
      && Date.parse(minutesIso(startMinutes)) < Date.parse(other.ends_at) && Date.parse(other.starts_at) < Date.parse(minutesIso(candidateEnd)));
    droppedOnRideId = collision?.id ?? rides.find((other) => other.id === droppedOnRideId)?.id ?? undefined;
    if (droppedOnRideId && droppedOnRideId !== rideId) {
      const driverEntry = servedOf(ride).find((s) => s.role === "driver");
      if (driverEntry?.request_id) {
        setMergePrefill({
          requestId: driverEntry.request_id,
          rideId: droppedOnRideId,
          type: "merge",
          payload: {
            ride_id: droppedOnRideId,
            legs: [{ ride_id: droppedOnRideId, role: "passenger", leg: "both", car_mode: "passenger" }],
          },
        });
      }
      return;
    }

    const oldStartMinutes = Math.round((Date.parse(ride.starts_at) - Date.parse(dayStartIso(selectedDay))) / 60_000);
    const oldEndMinutes = Math.round((Date.parse(ride.ends_at) - Date.parse(dayStartIso(selectedDay))) / 60_000);
    const durationMinutes = oldEndMinutes - oldStartMinutes;
    const newEndMinutes = resizedEndMinutes ?? startMinutes + durationMinutes;
    if (startMinutes < 0 || newEndMinutes > 1440 || newEndMinutes <= startMinutes) { toast.error(he.sadranBoard.invalidWindow); return; }

    const driverEntry = servedOf(ride).find((s) => s.role === "driver");
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
    if (wouldOverlap({ startsAt: newStartsAt, endsAt: newEndsAt }, otherRidesOnTargetCar, daySettings?.turnaround_minutes ?? 30)) {
      toast.error(he.sadranBoard.overlapToast);
      return;
    }

    if (withinDepartFlex) {
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
        pin_reason: prevInput.pin_reason ?? "SADRAN_MANUAL",
      };
      try {
        await editRideMutation.mutateAsync({ input: nextInput, expectedVersion: ride.version ?? undefined, departmentId, weekStart });
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
      goToComposer({ requestId: item.request.id, rideId: null, type: "deny", payload: { reason: "" } });
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

  const conflictCount = conflictRideIds.size;

  return (
    <div className="mx-auto max-w-6xl space-y-3 p-4 pb-24">
      <PageHeader title={he.screen.board.title} subtitle={formatWeekRangeLabel(weekStart)} />

      <div className="flex flex-wrap items-center gap-2">
        <Button variant="outline" size="sm" onClick={() => setReservation({ carId: carsQuery.data?.[0]?.id ?? "", start: "12:00", end: "16:00", notes: "" })}>{he.sadranBoard.reservation}</Button>
        <Select value={effectivePolicyVersionId ?? undefined} onValueChange={setPolicyVersionOverride}>
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
        <Button variant="outline" size="sm" onClick={handleUndo} disabled={!undoStack.canUndo}>
          {he.action.undo}
        </Button>
        <Button variant="outline" size="sm" onClick={() => navigate(`/sadran/${departmentId}/${weekStart}/publish`)}>
          {he.action.publish}
        </Button>
      </div>

      {conflictCount > 0 ? (
        <div className="rounded-md border border-destructive/40 bg-destructive/5 p-2 text-sm text-destructive">
          {tv("sadranBoard.conflictBanner", { count: String(conflictCount) })}
        </div>
      ) : null}

      <div className="flex items-center justify-between gap-2">
        <WeekStrip weekStart={weekStart} counts={dayCounts} selected={selectedDay} onSelect={setSelectedDay} />
        <Button variant="ghost" size="sm" className="hidden shrink-0 md:inline-flex" onClick={() => setShowEarlyHours((v) => !v)}>
          {showEarlyHours ? he.board.hideEarlyHours : he.board.showEarlyHours}
        </Button>
      </div>

      <RideTypeLegend types={(rideTypesQuery.data ?? []).map((rt) => ({ code: rt.code, nameHe: rt.name_he }))} />

      <div className="grid gap-3 lg:grid-cols-[minmax(0,1fr)_340px]">
        <div className="hidden min-w-0 md:block">
          <WeekGrid
            cars={weekGridCars}
            rides={weekGridRides}
            blocks={weekGridBlocks}
            dayStartMinutes={dayStartMinutes}
            dayEndMinutes={dayEndMinutes}
            readOnly={false}
            draggable
            canDragRide={(ride) => !ride.id.startsWith("change:")}
            canResizeRide={(ride) => !ride.id.startsWith("request:")}
            onSlotClick={(carId, minutes) => !carId.startsWith("phantom:") && setReservation({ carId, start: formatMinutes(minutes), end: formatMinutes(Math.min(1440, minutes + 60)), notes: "" })}
            onRideClick={(id) => id.startsWith("request:") ? setSelectedUnmetId(id.slice(8)) : setSelectedRideId(id)}
            onRideDrop={(rideId, carId, minutes, droppedOnRideId) => void handleRideDrop(rideId, carId, minutes, droppedOnRideId)}
            onRideResize={handleRideResize}
            isDropTargetValid={isDropTargetValid}
            externalDropTarget={
              unmetDragHover
                ? {
                    carId: unmetDragHover.carId,
                    startMinutes: unmetDragHover.minutes,
                    endMinutes: unmetDragHover.minutes + ((Date.parse(requestWindow(unmetDragHover.item.request)?.endsAt ?? "") - Date.parse(requestWindow(unmetDragHover.item.request)?.startsAt ?? "")) / 60_000 || 30),
                    label: `${unmetDragHover.item.request.requester_full_name ?? ""} · ${unmetDragHover.item.destinationName}`,
                    valid: isUnmetDropValid(unmetDragHover.item, unmetDragHover.carId, unmetDragHover.minutes),
                  }
                : null
            }
            onRideDropOnUnmet={(rideId) => void handleUnassignRide(rideId)}
          />
        </div>

        <BoardListMode
          rides={activeDayRides
            .filter((r) => r.id && r.starts_at)
            .map((r) => ({
              id: r.id as string,
              startsAt: r.starts_at as string,
              endsAt: r.ends_at,
              originName: r.origin_name ?? "",
              // Same fix as the grid's `rideBlockLabel` (bug #3): a round
              // trip's own `destination_name` is always home ("נבו").
              destinationName: r.notes || (
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
              isChauffeur: !!r.is_chauffeur,
              carName: (carsQuery.data ?? []).find((c) => c.id === r.car_id)?.name ?? null,
              carType: (carsQuery.data ?? []).find((c) => c.id === r.car_id)?.type,
              rideTypeCode: representativeRideTypeCode(servedOf(r)),
            }))}
          onRideClick={(id) => id.startsWith("request:") ? setSelectedUnmetId(id.slice(8)) : setSelectedRideId(id)}
          unmetItems={unmetItems}
          onUnmetAction={handleUnmetAction}
          onUnmetDecision={handleUnmetDecision}
          onOpenProposals={() => navigate(`/sadran/${departmentId}/${weekStart}/proposals`)}
        />

        {/* Bounded + independently scrollable at the same height as `WeekGrid`'s
            own `max-h-[70vh]` (UX_FLOWS §20 fast-follow): without this, a busy
            week's unmet list (40+ cards) has no height cap of its own, so its
            natural height stretches this whole grid row far past the
            viewport — bringing a far-down card into view then scrolls the
            *page*, carrying the target car column below/above the viewport
            with it, so the drag-from-unmet-list gesture (item 3) becomes
            physically impossible for any card that doesn't already fit
            alongside the grid on one screen. Keeping both panels
            independently scrollable at a matching height guarantees a source
            card and every car column can always be made visible together. */}
        <div
          className="hidden max-h-[70vh] overflow-y-auto lg:block"
          {...{ [UNMET_DROP_ZONE_ATTR]: "true" }}
        >
          {unmetItems.length === 0 ? (
            <EmptyState icon={CalendarDays} message={he.sadranBoard.noSuggestions} />
          ) : (
            <UnmetList
              items={unmetItems}
              onAction={handleUnmetAction}
              onDecision={handleUnmetDecision}
              dayStartMinutes={dayStartMinutes}
              dayEndMinutes={dayEndMinutes}
              onDragHover={(item, carId, minutes) => setUnmetDragHover(carId && minutes != null ? { item, carId, minutes } : null)}
              onDragDrop={(item, carId, minutes) => void handlePlaceUnmetRequest(item, carId, minutes)}
            />
          )}
        </div>
      </div>

      {/* Collapsible bottom drawer for the md–lg gap (UX_FLOWS §20): the
          grid already renders at `md:`, but the side panel above only shows
          at `lg:` — below that, the phone `BoardListMode` covers `< md` with
          its own "לא שובצו" segment, so this drawer specifically fills the
          space between. */}
      <div className="fixed bottom-4 end-4 z-40 hidden md:block lg:hidden">
        <Button variant="default" size="lg" className="relative shadow-lg" onClick={() => setUnmetDrawerOpen(true)}>
          {he.board.unmet}
          {unmetItems.length > 0 ? (
            <Badge variant="destructive" className="absolute -top-2 -start-2 min-w-5 justify-center px-1">
              {unmetItems.length}
            </Badge>
          ) : null}
        </Button>
      </div>
      <Sheet open={unmetDrawerOpen} onOpenChange={setUnmetDrawerOpen}>
        <SheetContent side="bottom" className="max-h-[80dvh] overflow-y-auto" {...{ [UNMET_DROP_ZONE_ATTR]: "true" }}>
          <SheetHeader>
            <SheetTitle>{tv("sadranBoard.unmetTitle", { count: String(unmetItems.length) })}</SheetTitle>
          </SheetHeader>
          <div className="py-2">
            {unmetItems.length === 0 ? (
              <EmptyState icon={CalendarDays} message={he.sadranBoard.noSuggestions} />
            ) : (
              <UnmetList
                items={unmetItems}
                onAction={handleUnmetAction}
              onDecision={handleUnmetDecision}
                dayStartMinutes={dayStartMinutes}
                dayEndMinutes={dayEndMinutes}
                onDragHover={(item, carId, minutes) => setUnmetDragHover(carId && minutes != null ? { item, carId, minutes } : null)}
                onDragDrop={(item, carId, minutes) => void handlePlaceUnmetRequest(item, carId, minutes)}
              />
            )}
          </div>
        </SheetContent>
      </Sheet>

      <Dialog open={!!mergePrefill} onOpenChange={(open) => !open && setMergePrefill(null)}>
        <DialogContent><DialogHeader><DialogTitle>{he.sadranBoard.mergeConfirm}</DialogTitle><DialogDescription>{he.sadranBoard.mergeDescription}</DialogDescription></DialogHeader>
          <Button onClick={() => { if (mergePrefill) goToComposer(mergePrefill); setMergePrefill(null); }}>{he.sadranBoard.prepareMerge}</Button>
          <Button variant="outline" onClick={() => setMergePrefill(null)}>{he.common.cancel}</Button>
        </DialogContent>
      </Dialog>
      <Sheet open={!!selectedUnmet} onOpenChange={(open) => !open && setSelectedUnmetId(null)}>
        <SheetContent side="bottom"><SheetHeader><SheetTitle>{he.board.unmet}</SheetTitle></SheetHeader>
          {selectedUnmet ? <UnmetList items={[selectedUnmet]} onAction={handleUnmetAction} onDecision={handleUnmetDecision} /> : null}
        </SheetContent>
      </Sheet>
      <Dialog open={!!reservation} onOpenChange={(open) => !open && setReservation(null)}>
        <DialogContent><DialogHeader><DialogTitle>{he.sadranBoard.reservation}</DialogTitle><DialogDescription>{selectedDay}</DialogDescription></DialogHeader>
          {reservation ? <>
            <Select value={reservation.carId} onValueChange={(carId) => setReservation({ ...reservation, carId })}><SelectTrigger><SelectValue /></SelectTrigger><SelectContent>{(carsQuery.data ?? []).map((car) => <SelectItem key={car.id} value={car.id}>{car.name}</SelectItem>)}</SelectContent></Select>
            <div className="flex gap-2"><TimeField15 min="00:00" aria-label={he.sadranRideSheet.depart} value={reservation.start} onChange={(start) => setReservation({ ...reservation, start })} /><TimeField15 min="00:00" aria-label={he.sadranRideSheet.return} value={reservation.end} onChange={(end) => setReservation({ ...reservation, end })} /></div>
            <Textarea aria-label={he.sadranBoard.reservationNotes} placeholder={he.sadranBoard.reservationNotes} value={reservation.notes} onChange={(event) => setReservation({ ...reservation, notes: event.target.value })} />
            <Button disabled={editRideMutation.isPending || !reservation.notes.trim() || !reservation.carId} onClick={() => void saveReservation()}>{he.common.save}</Button>
          </> : null}
        </DialogContent>
      </Dialog>
      <RideSheet
        ride={selectedRide}
        cars={carsQuery.data ?? []}
        driverName={selectedRideDriverName}
        homeDestinationId={department?.home_destination_id ?? null}
        onOpenChange={(open) => !open && setSelectedRideId(null)}
        saving={editRideMutation.isPending}
        onSave={(input) => {
          if (!selectedRide?.id || !selectedRide.origin_id || !selectedRide.destination_id) return;
          if (Date.parse(input.endsAt) <= Date.parse(input.startsAt)) { toast.error(he.sadranBoard.invalidWindow); return; }
          const outsideFlex = servedOf(selectedRide).map((entry) => (requestsQuery.data ?? []).find((req) => req.id === entry.request_id))
            .find((req) => req && !requestWithinFlex(req, input.startsAt, input.endsAt));
          if (outsideFlex) {
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
          const otherRidesOnTargetCar = rides
            .filter((r) => r.id !== selectedRide.id && r.car_id === input.carId && r.starts_at && r.ends_at)
            .map((r) => ({ startsAt: r.starts_at as string, endsAt: r.ends_at as string }));
          if (wouldOverlap({ startsAt: input.startsAt, endsAt: input.endsAt }, otherRidesOnTargetCar, daySettings?.turnaround_minutes ?? 30)) {
            toast.error(he.sadranBoard.overlapToast);
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
                notes: input.notes,
                overnight_ack: input.overnightAck,
                // Manual save (including a plain car change via the sheet's
                // select, the no-drag fallback bug #2 asks for) auto-pins,
                // same reasoning as the drag path above.
                is_pinned: true,
                pin_reason: selectedRide.pin_reason ?? "SADRAN_MANUAL",
                served: servedToEditRideLegs(servedOf(selectedRide)),
              },
              expectedVersion: selectedRide.version ?? undefined,
              departmentId,
              weekStart,
            })
            .then(() => setSelectedRideId(null))
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
