import { formatInTimeZone, fromZonedTime } from "date-fns-tz";
import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { toast } from "sonner";
import { useQuery } from "@tanstack/react-query";

import { datesOfWeek, formatWeekRangeLabel, todayInJerusalem } from "@/components/DateField";
import { EmptyState } from "@/components/EmptyState";
import { ErrorState } from "@/components/ErrorState";
import { PageHeader } from "@/components/PageHeader";
import { formatMinutes } from "@/components/TimeField15";
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
import { parseFlexInterval, parseTimeToMinutes } from "@/features/solverBridge/buildSolverInput";
import { CalendarDays } from "lucide-react";
import { fetchCarSeatConfigs } from "@/features/fleet/api";
import { useCarLocations, useDepartments } from "@/features/siddur/hooks";
import { he, tv } from "@/i18n/he";
import { TZ } from "@/lib/time";

import { scanBoardConflicts, withinFlex, wouldOverlap } from "../geometry";
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
  usePolicyOptions,
  useProposalsForWeek,
  useWeekRequestsWithNames,
} from "../../hooks";
import {
  buildApplyPayload,
  gatherSolverContext,
  hashSolverInput,
  nowMs,
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
  const requestsQuery = useWeekRequestsWithNames(departmentId, weekStart);
  const ridesQuery = useAllWeekRides(departmentId, weekStart);
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
  const applySolverResultMutation = useApplySolverResultMutation();
  const undoStack = useUndoStack<void>();
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
      if (!isUnmetStatus(r.status) || !r.depart_at) continue;
      const d = formatInTimeZone(new Date(r.depart_at), TZ, "yyyy-MM-dd");
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
   * MAJOR BUG fix (docs/UX_FLOWS.md §19): this board has no "apply the full
   * re-solve" action of its own — only "▶ השלם אוטומטית" below actually
   * writes anything, and that always runs in `'remaining'` mode. Previewing
   * in `'full'` mode here used to forecast a solve the board could never
   * actually apply (and, before the root-cause fix in `applySolve.ts`,
   * under-reported unmet requests whose ride was an unpinned solver draft —
   * exactly the requests that were disappearing). Matching the preview's
   * mode to the only apply path this screen offers keeps what the Sadran
   * sees in sync with what a click on "השלם אוטומטית" will actually do.
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
      label:
        department?.home_destination_id && r.origin_id && r.destination_id
          ? rideBlockLabel({
              originId: r.origin_id,
              destinationId: r.destination_id,
              originName: r.origin_name ?? "",
              destinationName: r.destination_name ?? "",
              homeDestinationId: department.home_destination_id,
              served: servedOf(r),
            })
          : (r.destination_name ?? ""),
      pinned: !!r.is_pinned,
      conflict: conflictScan?.conflictRideIds.has(r.id as string) ?? false,
      pendingConsent: pendingConsentRideIds.has(r.id as string),
    }));

  const weekGridBlocks: WeekGridBlock[] = [];

  const dayCounts = days.map((d) => ({
    rides: rides.filter((r) => r.starts_at && formatInTimeZone(new Date(r.starts_at), TZ, "yyyy-MM-dd") === d).length,
    unmet: (requestsQuery.data ?? []).filter(
      (r) => isUnmetStatus(r.status) && r.depart_at && formatInTimeZone(new Date(r.depart_at), TZ, "yyyy-MM-dd") === d,
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
    .filter((r) => isUnmetStatus(r.status))
    .map((r) => ({
      request: r,
      destinationName: r.destination_resolved_name ?? "—",
      solverInfo: preview?.output.unmet.find((u) => u.requestId === r.id),
    }));

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

  /**
   * Live drag feedback (UX_FLOWS §4.2 "Seat-fit and maintenance checked
   * live; invalid rows are greyed while dragging", owner bug report #2).
   * Only seats + time-overlap are checked here (against the ride's *current*
   * window — the definitive check with the *actual* dropped time happens in
   * `handleRideDrop` right before the mutation call).
   */
  function isDropTargetValid(rideId: string, carId: string): boolean {
    const ride = rides.find((r) => r.id === rideId);
    if (!ride?.starts_at || !ride.ends_at) return true;
    if (!seatsFit(carId, passengersOf(ride))) return false;
    const others = rides
      .filter((r) => r.id !== rideId && r.car_id === carId && r.starts_at && r.ends_at)
      .map((r) => ({ startsAt: r.starts_at as string, endsAt: r.ends_at as string }));
    return !wouldOverlap({ startsAt: ride.starts_at, endsAt: ride.ends_at }, others, daySettings?.turnaround_minutes ?? 30);
  }

  function unmetRequestPassengers(r: WeekRequestRow) {
    return { adults: r.adults, childSeats: r.child_seats, boosters: r.boosters };
  }

  /**
   * Candidate window for placing an unmet request's own declared
   * depart/return times onto `minutes` (drag-drop start, UX_FLOWS §20 item
   * 3) — only round trips are placeable this way (no single "host" ride to
   * create for a one-way request; the same restriction the pure solver's
   * `tryAutoApprove`/DB `try_auto_approve()` apply, `src/solver/live.ts`).
   */
  function unmetCandidateWindow(item: UnmetListItem, minutes: number): { startsAt: string; endsAt: string } | null {
    const req = item.request;
    if (req.trip_shape !== "round_trip" || !req.depart_at || !req.return_at) return null;
    const durationMinutes = Math.round((Date.parse(req.return_at) - Date.parse(req.depart_at)) / 60_000);
    return {
      startsAt: fromZonedTime(`${selectedDay}T${formatMinutes(minutes)}:00`, TZ).toISOString(),
      endsAt: fromZonedTime(`${selectedDay}T${formatMinutes(minutes + durationMinutes)}:00`, TZ).toISOString(),
    };
  }

  /** Live drag feedback for an unmet card hovering a car column — same seat-fit/overlap checks as `isDropTargetValid` above. */
  function isUnmetDropValid(item: UnmetListItem, carId: string, minutes: number): boolean {
    const window = unmetCandidateWindow(item, minutes);
    if (!window) return false;
    if (!seatsFit(carId, unmetRequestPassengers(item.request))) return false;
    const others = rides
      .filter((r) => r.car_id === carId && r.starts_at && r.ends_at)
      .map((r) => ({ startsAt: r.starts_at as string, endsAt: r.ends_at as string }));
    return !wouldOverlap(window, others, daySettings?.turnaround_minutes ?? 30);
  }

  /**
   * Drop target for an unmet card dragged onto a car column (UX_FLOWS §20
   * item 3): creates the ride via `edit_ride` with no `id` — its own insert
   * branch (`supabase/migrations/20260907091500_rpc.sql`) is exactly "the
   * Sadran's single-ride create/move/reassign/pin path", auto-pins, and
   * marks the served request `assigned`, mirroring the shape
   * `tryAutoApprove`/`try_auto_approve()` already use for a round trip
   * (`origin_id === destination_id === home`, `car_mode: 'keep'`). Reused
   * read-only here — no new RPC needed.
   */
  async function handlePlaceUnmetRequest(item: UnmetListItem, carId: string, minutes: number) {
    setUnmetDragHover(null);
    const req = item.request;
    const window = unmetCandidateWindow(item, minutes);
    if (!window || !department?.home_destination_id) {
      toast(he.sadranBoard.dragOneWayUnsupported);
      return;
    }
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
          driver_id: req.requester_id,
          is_pinned: true,
          pin_reason: "SADRAN_MANUAL",
          served: [{ request_id: req.id, role: "driver", leg: "both", car_mode: "keep" }],
        },
        departmentId,
        weekStart,
      });
      const carName = (carsQuery.data ?? []).find((c) => c.id === carId)?.name ?? "";
      toast.success(tv("sadranBoard.dragPlacedToast", { car: carName, start: formatMinutes(minutes) }));
    } catch {
      // toast already shown by the mutation
    }
  }

  /**
   * Reverse gesture (UX_FLOWS §20 item 3): a ride block dragged out of the
   * grid onto the unmet panel/drawer. No RPC returns a served request
   * straight to `submitted` (only `cancel_ride`, which sets `cancelled`) —
   * same underlying call as `RideSheet`'s "הסר שיבוץ" button, applied
   * immediately since this was already a deliberate drag+release gesture
   * (same philosophy as `handleRideDrop`'s within-flex path below).
   */
  async function handleUnassignRide(rideId: string) {
    const ride = rides.find((r) => r.id === rideId);
    try {
      await cancelRideMutation.mutateAsync({
        rideId,
        reason: he.sadranRideSheet.removeAssignmentReason,
        expectedVersion: ride?.version ?? undefined,
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

  async function handleRideDrop(rideId: string, carId: string, startMinutes: number, droppedOnRideId?: string) {
    const ride = rides.find((r) => r.id === rideId);
    if (!ride?.id || !ride.starts_at || !ride.ends_at || !ride.car_id || !ride.origin_id || !ride.destination_id) return;

    if (droppedOnRideId && droppedOnRideId !== rideId) {
      const driverEntry = servedOf(ride).find((s) => s.role === "driver");
      if (driverEntry?.request_id) {
        goToComposer({
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
    const newEndMinutes = startMinutes + durationMinutes;
    const shiftMinutes = startMinutes - oldStartMinutes;

    const driverEntry = servedOf(ride).find((s) => s.role === "driver");
    const driverRequest = driverEntry ? (requestsQuery.data ?? []).find((r) => r.id === driverEntry.request_id) : undefined;
    const withinDepartFlex = driverRequest
      ? withinFlex(shiftMinutes, parseFlexInterval(driverRequest.flex_depart_early), parseFlexInterval(driverRequest.flex_depart_late))
      : shiftMinutes === 0;

    const newStartsAt = fromZonedTime(`${selectedDay}T${formatMinutes(startMinutes)}:00`, TZ).toISOString();
    const newEndsAt = fromZonedTime(`${selectedDay}T${formatMinutes(newEndMinutes)}:00`, TZ).toISOString();

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
        driver_id: ride.driver_id ?? "",
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
        toast.success(he.sadranBoard.dragAppliedToast);
        undoStack.push({
          label: ride.destination_name ?? ride.id,
          run: async () => {
            await editRideMutation.mutateAsync({ input: prevInput, departmentId, weekStart });
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
        payload: { car_id: carId, depart_at: newStartsAt, return_at: newEndsAt },
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
    void handleRideDrop(rideId, ride.car_id, newStart);
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
    const result = await undoStack.undo();
    if (result) toast.success(tv("sadranBoard.undoToast", { label: result.label }));
    else toast(he.sadranBoard.undoNothing);
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
    return <div className="flex min-h-[50dvh] items-center justify-center text-muted-foreground">{he.common.loading}</div>;
  }

  const conflictCount = conflictScan?.conflictRideIds.size ?? 0;

  return (
    <div className="mx-auto max-w-6xl space-y-3 p-4 pb-24">
      <PageHeader title={he.screen.board.title} subtitle={formatWeekRangeLabel(weekStart)} />

      <div className="flex flex-wrap items-center gap-2">
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

      <div className="grid gap-3 lg:grid-cols-[1fr_340px]">
        <div className="hidden md:block">
          <WeekGrid
            cars={weekGridCars}
            rides={weekGridRides}
            blocks={weekGridBlocks}
            dayStartMinutes={dayStartMinutes}
            dayEndMinutes={dayEndMinutes}
            readOnly={false}
            draggable
            onRideClick={setSelectedRideId}
            onRideDrop={(rideId, carId, minutes, droppedOnRideId) => void handleRideDrop(rideId, carId, minutes, droppedOnRideId)}
            onRideResize={handleRideResize}
            isDropTargetValid={isDropTargetValid}
            externalDropTarget={
              unmetDragHover
                ? {
                    carId: unmetDragHover.carId,
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
              destinationName:
                department?.home_destination_id && r.origin_id && r.destination_id
                  ? resolveRideRealDestination({
                      originId: r.origin_id,
                      destinationId: r.destination_id,
                      originName: r.origin_name ?? "",
                      destinationName: r.destination_name ?? "",
                      homeDestinationId: department.home_destination_id,
                      served: servedOf(r),
                    })
                  : (r.destination_name ?? ""),
              driverName: r.driver_name,
              isChauffeur: !!r.is_chauffeur,
              carName: (carsQuery.data ?? []).find((c) => c.id === r.car_id)?.name ?? null,
              carType: (carsQuery.data ?? []).find((c) => c.id === r.car_id)?.type,
            }))}
          onRideClick={setSelectedRideId}
          unmetItems={unmetItems}
          onUnmetAction={handleUnmetAction}
          onOpenProposals={() => navigate(`/sadran/${departmentId}/${weekStart}/proposals`)}
        />

        <div className="hidden lg:block" {...{ [UNMET_DROP_ZONE_ATTR]: "true" }}>
          {unmetItems.length === 0 ? (
            <EmptyState icon={CalendarDays} message={he.sadranBoard.noSuggestions} />
          ) : (
            <UnmetList
              items={unmetItems}
              onAction={handleUnmetAction}
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
                dayStartMinutes={dayStartMinutes}
                dayEndMinutes={dayEndMinutes}
                onDragHover={(item, carId, minutes) => setUnmetDragHover(carId && minutes != null ? { item, carId, minutes } : null)}
                onDragDrop={(item, carId, minutes) => void handlePlaceUnmetRequest(item, carId, minutes)}
              />
            )}
          </div>
        </SheetContent>
      </Sheet>

      <RideSheet
        ride={selectedRide}
        cars={carsQuery.data ?? []}
        driverName={selectedRideDriverName}
        homeDestinationId={department?.home_destination_id ?? null}
        onOpenChange={(open) => !open && setSelectedRideId(null)}
        saving={editRideMutation.isPending}
        onSave={(input) => {
          if (!selectedRide?.id || !selectedRide.origin_id || !selectedRide.destination_id) return;
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
                driver_id: selectedRide.driver_id ?? "",
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
              driver_id: selectedRide.driver_id ?? "",
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
