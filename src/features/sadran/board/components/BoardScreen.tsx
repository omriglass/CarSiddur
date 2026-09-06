import { formatInTimeZone, fromZonedTime } from "date-fns-tz";
import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { toast } from "sonner";

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
import { WeekGrid, type WeekGridBlock, type WeekGridCar, type WeekGridRide } from "@/components/WeekGrid";
import { WeekStrip } from "@/components/WeekStrip";
import { parseFlexInterval } from "@/features/solverBridge/buildSolverInput";
import { CalendarDays } from "lucide-react";
import { useCarLocations, useDepartments } from "@/features/siddur/hooks";
import { he, tv } from "@/i18n/he";
import { TZ } from "@/lib/time";

import { scanBoardConflicts, withinFlex } from "../geometry";
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
  useWeekRequests,
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

import type { EditRideInput } from "../../api";
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
  const [selectedDay, setSelectedDay] = useState(days.includes(today) ? today : (days[0] ?? weekStart));
  const [selectedRideId, setSelectedRideId] = useState<string | null>(null);

  const carsQuery = useCarsForDepartment(departmentId);
  const carLocationsQuery = useCarLocations(departmentId, weekStart);
  const requestsQuery = useWeekRequests(departmentId, weekStart);
  const ridesQuery = useAllWeekRides(departmentId, weekStart);
  const proposalsQuery = useProposalsForWeek(departmentId, weekStart);
  const departmentSettingsQuery = useDepartmentSettings(departmentId);
  const activePolicyQuery = useActivePolicy(departmentId);
  const policyOptionsQuery = usePolicyOptions(departmentId);

  const editRideMutation = useEditRideMutation();
  const cancelRideMutation = useCancelRideMutation();
  const applySolverResultMutation = useApplySolverResultMutation();
  const undoStack = useUndoStack<void>();
  const [autoSolving, setAutoSolving] = useState(false);

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
        mode: "full",
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
      });
      await applySolverResultMutation.mutateAsync({
        departmentId,
        weekStart,
        payload: payload as unknown as Json,
      });
      setPreview({ output, policyVersionId: policy.policyVersionId });
      toast.success(he.sadranDashboard.applied);
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
      label: r.destination_name ?? "",
      pinned: !!r.is_pinned,
      conflict: conflictScan?.conflictRideIds.has(r.id as string) ?? false,
      pendingConsent: pendingConsentRideIds.has(r.id as string),
    }));

  const weekGridBlocks: WeekGridBlock[] = [];

  const dayCounts = days.map((d) => ({
    rides: rides.filter((r) => r.starts_at && formatInTimeZone(new Date(r.starts_at), TZ, "yyyy-MM-dd") === d).length,
    unmet: (requestsQuery.data ?? []).filter(
      (r) => (r.status === "waitlisted" || r.status === "denied") && r.depart_at && formatInTimeZone(new Date(r.depart_at), TZ, "yyyy-MM-dd") === d,
    ).length,
  }));

  const unmetItems: UnmetListItem[] = (requestsQuery.data ?? [])
    .filter((r) => r.status === "waitlisted" || r.status === "denied")
    .map((r) => ({
      request: r,
      destinationName: r.destination_text ?? "—",
      solverInfo: preview?.output.unmet.find((u) => u.requestId === r.id),
    }));

  const selectedRide = rides.find((r) => r.id === selectedRideId) ?? null;
  const selectedRideDriverName = selectedRide?.driver_name ?? null;

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
      const nextInput: EditRideInput = { ...prevInput, car_id: carId, starts_at: newStartsAt, ends_at: newEndsAt };
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

      <WeekStrip weekStart={weekStart} counts={dayCounts} selected={selectedDay} onSelect={setSelectedDay} />

      <div className="grid gap-3 lg:grid-cols-[1fr_340px]">
        <div className="hidden md:block">
          <WeekGrid
            cars={weekGridCars}
            rides={weekGridRides}
            blocks={weekGridBlocks}
            readOnly={false}
            draggable
            onRideClick={setSelectedRideId}
            onRideDrop={(rideId, carId, minutes, droppedOnRideId) => void handleRideDrop(rideId, carId, minutes, droppedOnRideId)}
            onRideResize={handleRideResize}
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
              destinationName: r.destination_name ?? "",
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

        <div className="hidden lg:block">
          {unmetItems.length === 0 ? (
            <EmptyState icon={CalendarDays} message={he.sadranBoard.noSuggestions} />
          ) : (
            <UnmetList items={unmetItems} onAction={handleUnmetAction} />
          )}
        </div>
      </div>

      <RideSheet
        ride={selectedRide}
        cars={carsQuery.data ?? []}
        driverName={selectedRideDriverName}
        onOpenChange={(open) => !open && setSelectedRideId(null)}
        saving={editRideMutation.isPending}
        onSave={(input) => {
          if (!selectedRide?.id || !selectedRide.origin_id || !selectedRide.destination_id) return;
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
                is_pinned: !!selectedRide.is_pinned,
                pin_reason: selectedRide.pin_reason,
                served: servedToEditRideLegs(servedOf(selectedRide)),
              },
              expectedVersion: selectedRide.version ?? undefined,
              departmentId,
              weekStart,
            })
            .then(() => setSelectedRideId(null));
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
            .then(() => setSelectedRideId(null));
        }}
      />
    </div>
  );
}
