// Extracted from `BoardScreen.tsx` (docs/TODO.md "Code review 2026-09-24" R9):
// drag/drop + selection state, the ride-reservation dialog's own state, and
// every handler that mutates rides/proposals from the board. Pure move —
// behaviour unchanged. `board` is `useBoardData`'s return value; this hook
// reads the pieces it needs from it instead of re-deriving them.
import { useRef, useState } from "react";
import { useNavigate, useLocation } from "react-router-dom";
import { toast } from "sonner";
import { useQuery } from "@tanstack/react-query";

import { paths } from "@/app/routes";
import { formatMinutes, parseHHMM } from "@/components/timeField15Format";
import { he, tv } from "@/i18n/he";
import { dateKey } from "@/lib/time";
import { useSession } from "@/features/auth/useSession";
import { useDepartmentMembers } from "@/features/auth/useDepartmentMembers";
import { fetchChildren } from "@/features/requests/api";

import { expandedMergeWindow } from "../mergeWindow";
import { requestStart, requestWindow, requestWithinFlex } from "../phantomLanes";
import {
  isUnmetDropValid,
  minutesIso,
  passengersOf,
  seatsFit,
  unavailable,
  unmetCandidateWindow,
  unmetMergeHost,
  unmetRequestPassengers,
} from "../dropValidity";
import type { UnmetListItem } from "../components/UnmetList";
import { wouldOverlap } from "../geometry";
import { buildRidePassengerInputs, splitReservationDriverAndPassengers } from "../reservationPeople";
import {
  useEditRideMutation,
  useSetRidePassengersMutation,
  useUnassignRideMutation,
  useCancelRideMutation,
} from "../../hooks";
import { useClaimRideDriverMutation, useCancelRideChangeMutation } from "@/features/rides/hooks";
import { useUndoStack } from "../useUndoStack";
import { servedOf, servedToEditRideLegs } from "../../solverRun";

import type { EditRideInput, RidePassengerInput, WeekRequestRow } from "../../api";
import type { Suggestion } from "@/solver";
import type { useBoardData } from "./useBoardData";

export type BoardData = ReturnType<typeof useBoardData>;

/**
 * Interactive board state (selection, drag hover, the reservation/merge
 * dialogs) plus every handler that writes to rides/proposals/passengers.
 * Reads its data (rides, requests, cars, …) off `board` (`useBoardData`).
 */
export function useBoardDnd(departmentId: string, weekStart: string, board: BoardData) {
  const navigate = useNavigate();
  const location = useLocation();

  const [selectedRideId, setSelectedRideId] = useState<string | null>(null);
  const [selectedGroupId, setSelectedGroupId] = useState<string | null>(null);
  const [selectedUnmetId, setSelectedUnmetId] = useState<string | null>(null);
  // Swap cars on a day by dragging car names (REQ §13.92, owner batch 2026-09-24 S1) — the
  // Sadran is allowed on any non-archived day (planning, no notifications).
  const [carSwapPair, setCarSwapPair] = useState<{ carA: string; carB: string } | null>(null);
  const [mergePrefill, setMergePrefill] = useState<Parameters<typeof goToComposer>[0] | null>(null);
  // memberIds: department members picked for the reservation, in pick order — the first
  // becomes the ride's driver (owner A5, 2026-09-14); the rest (plus childIds) become
  // `ride_passengers` rows via set_ride_passengers() once the ride itself is saved.
  const [reservation, setReservation] = useState<{ carId: string; start: string; end: string; notes: string; memberIds: string[]; childIds: string[] } | null>(null);
  // Multi-day request ("series") car-change confirmation (REQ §13.77, UX_FLOWS.md §4.2):
  // dragging a series leg onto a different car moves every day of the span — confirm first,
  // since a car free on this day only is not necessarily free for the whole series (MDR03).
  const [seriesMoveConfirm, setSeriesMoveConfirm] = useState<{ carName: string; index: number; count: number; run: () => Promise<void> } | null>(null);
  // Drag-an-unmet-card-onto-a-car-column (UX_FLOWS §20 item 3): live hover
  // state reported by `UnmetList`'s own pointer tracking (it owns the
  // gesture since the drag starts on its cards, outside the grid) — the
  // grid only needs to know which car to highlight and whether the drop
  // would be valid right now.
  const [unmetDragHover, setUnmetDragHover] = useState<{ item: UnmetListItem; carId: string; minutes: number; hostRideId?: string } | null>(null);

  const editRideMutation = useEditRideMutation();
  const setRidePassengersMutation = useSetRidePassengersMutation();
  const claimDriverMutation = useClaimRideDriverMutation();
  const cancelRideChangeMutation = useCancelRideChangeMutation();
  const cancelRideMutation = useCancelRideMutation();
  const unassignRideMutation = useUnassignRideMutation();
  const undoStack = useUndoStack<void>();
  const undoVersions = useRef(new Map<string, number>());

  // Reservation dialog's optional people picker (F3, docs/TODO.md, owner A5 2026-09-14):
  // department members (first picked = driver) + the department's children, same source
  // queries `RequestForm`'s own companions/children pickers use.
  const { session } = useSession();
  const profileId = session?.user.id;
  const reservationMembersQuery = useDepartmentMembers(departmentId);
  const reservationReferenceYear = Number((board.days[0] ?? weekStart).slice(0, 4));
  const reservationChildrenQuery = useQuery({
    queryKey: ["children", departmentId, profileId, reservationReferenceYear],
    queryFn: () => fetchChildren(departmentId, profileId as string, reservationReferenceYear),
    enabled: !!departmentId && !!profileId,
  });

  const { selectedDay, dayStartIso, dropCtx, rides, pendingMerges } = board;
  const requestsData = board.requestsQuery.data ?? [];
  const carsData = board.carsQuery.data ?? [];
  const department = board.department;

  function goToComposer(prefill: {
    requestId: string;
    rideId: string | null;
    type: "shift" | "merge" | "deny" | "external";
    payload: Record<string, unknown>;
    proposalId?: string;
  }) {
    navigate(paths.sadran.composer(departmentId, weekStart), { state: { ...prefill, returnTo: location.pathname + location.search } });
  }

  /** Assign a request leg or prepare a proposal when sharing/relay coordination is required. */
  async function handlePlaceUnmetRequest(item: UnmetListItem, carId: string, minutes: number, droppedOnRideId?: string) {
    setUnmetDragHover(null);
    const req = item.request;
    if (carId.startsWith("phantom:")) return;
    if (!requestStart(req) || dateKey(requestStart(req)!) !== selectedDay) {
      toast.error(he.sadranBoard.wrongDay); return;
    }
    let window = unmetCandidateWindow(dropCtx, item, minutes);
    if (!window || !department?.home_destination_id) {
      toast.error(he.sadranBoard.invalidWindow);
      return;
    }
    const host = unmetMergeHost(dropCtx, item, carId, minutes, droppedOnRideId);
    if (host?.id && host.starts_at && host.ends_at) {
      if (!host.driver_id || host.needs_driver) { toast.error(he.boardCoordination.mergeNeedsDriver); return; }
      if (!isUnmetDropValid(dropCtx, item, carId, minutes, droppedOnRideId)) { toast.error(he.sadranBoard.dragInvalidOverlapToast); return; }
      const original = requestWindow(req)!;
      const expanded = expandedMergeWindow({ startsAt: host.starts_at, endsAt: host.ends_at }, original);
      setMergePrefill({ requestId: req.id, rideId: host.id, type: "merge", payload: { ride_id: host.id,
        starts_at: expanded.startsAt, ends_at: expanded.endsAt,
        legs: [{ ride_id: host.id, role: "passenger", leg: req.trip_shape === "round_trip" ? "both" : req.trip_shape === "one_way_from" ? "return" : "out", car_mode: "passenger" }] } });
      return;
    }
    window = unmetCandidateWindow(dropCtx, item, minutes, true);
    if (!window) { toast.error(he.sadranBoard.invalidWindow); return; }
    if (unavailable(dropCtx, carId, window.startsAt, window.endsAt)) { toast.error(he.sadranBoard.maintenanceUnavailable); return; }
    if (!seatsFit(dropCtx, carId, unmetRequestPassengers(req))) {
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
      const carName = carsData.find((c) => c.id === carId)?.name ?? "";
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

  function handleRideClick(id: string) {
    if (id.startsWith("change:")) {
      const change = (board.rideChangesQuery.data ?? []).find((change) => `change:${change.id}` === id);
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
    const planningChange = (board.rideChangesQuery.data ?? []).find((change) => change.is_planning && `change:${change.id}` === rideId);
    if (planningChange) {
      if (carId.startsWith("phantom:")) { await cancelRideChangeMutation.mutateAsync(planningChange.id); return; }
      rideId = planningChange.ride_id;
      resizedEndMinutes ??= startMinutes + (Date.parse(planningChange.ends_at) - Date.parse(planningChange.starts_at)) / 60_000;
    }
    if (rideId.startsWith("request:")) {
      const item = board.unmetItems.find((item) => `request:${item.request.id}` === rideId);
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
        const sourceRequest = requestsData.find((request) => request.id === driverEntry.request_id);
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
    const driverRequest = driverEntry ? requestsData.find((r) => r.id === driverEntry.request_id) : undefined;
    const newStartsAt = minutesIso(dropCtx, startMinutes);
    const newEndsAt = minutesIso(dropCtx, newEndMinutes);
    if (unavailable(dropCtx, carId, newStartsAt, newEndsAt)) { toast.error(he.sadranBoard.maintenanceUnavailable); return; }
    const servedRequests = servedOf(ride).map((entry) => requestsData.find((req) => req.id === entry.request_id)).filter((req): req is WeekRequestRow => !!req);
    const withinDepartFlex = servedRequests.every((req) => requestWithinFlex(req, newStartsAt, newEndsAt));

    // Conflicts checked and reported in Hebrew *before* touching the DB
    // (owner bug report #2: "confirm conflicts — overlap/buffer/location/
    // seat fit — are checked and reported in Hebrew on drop"). Location/
    // overnight-chain is still enforced server-side by `assert_car_chain`
    // inside `edit_ride` (`lib/rpc.ts`'s `car_chain_broken` -> `he.errors.
    // carChainBroken`); seat-fit and same-car overlap have no DB check at
    // all today, so they're validated here against the *real* dropped time.
    if (carId !== ride.car_id && !seatsFit(dropCtx, carId, passengersOf(ride))) {
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
      // Captured outside `applyMove` (a closure): TS's property-narrowing from the early
      // `!ride?.id` guard above does not carry into a nested function body.
      const undoLabel = ride.destination_name ?? ride.id;
      const applyMove = async () => {
        try {
          await editRideMutation.mutateAsync({ input: nextInput, expectedVersion: planningChange?.expected_version ?? ride.version ?? undefined, departmentId, weekStart });
          if (hasCollision && ride.status !== "draft") { toast.success(he.boardCoordination.planningSaved); return; }
          undoVersions.current.set(rideId, (ride.version ?? 0) + 1);
          toast.success(he.sadranBoard.dragAppliedToast);
          undoStack.push({
            label: undoLabel,
            run: async () => {
              const expectedVersion = undoVersions.current.get(rideId) ?? (ride.version ?? 0) + 1;
              await editRideMutation.mutateAsync({ input: prevInput, expectedVersion, departmentId, weekStart });
              undoVersions.current.set(rideId, expectedVersion + 1);
            },
            // Redo: re-apply the same drag/resize/save edit that was just
            // reverted, symmetric to `run()` above (both read/write the same
            // `undoVersions` map so a redo followed by another undo keeps
            // using the right `expected_version`).
            redo: async () => {
              const expectedVersion = undoVersions.current.get(rideId) ?? (ride.version ?? 0) + 1;
              await editRideMutation.mutateAsync({ input: nextInput, expectedVersion, departmentId, weekStart });
              undoVersions.current.set(rideId, expectedVersion + 1);
            },
          });
        } catch {
          // toast already shown by the mutation (e.g. MDR03 "series_car_unavailable")
        }
      };
      // Multi-day request ("series", REQ §13.77): a car change drags every leg of the span
      // along (`edit_ride` calls `move_series` server-side) — confirm before dragging days
      // the Sadran cannot currently see. A time-only drag (same car) needs no extra
      // confirmation; the server's own MDR02 error explains a disallowed middle-leg time move.
      if (ride.series_id && carId !== ride.car_id) {
        const carName = carsData.find((c) => c.id === carId)?.name ?? "";
        setSeriesMoveConfirm({ carName, index: ride.series_index ?? 1, count: ride.series_count ?? 1, run: applyMove });
        return;
      }
      await applyMove();
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
    // First picked member = driver (owner A5, 2026-09-14); everyone else picked, plus any
    // picked children, become named `ride_passengers` once the ride itself exists.
    const { driverId, passengerMemberIds } = splitReservationDriverAndPassengers(reservation.memberIds);
    try {
      const rideId = await editRideMutation.mutateAsync({ input: { department_id: departmentId, week_start: weekStart, car_id: reservation.carId,
        starts_at: minutesIso(dropCtx, start), ends_at: minutesIso(dropCtx, end), origin_id: department.home_destination_id, destination_id: department.home_destination_id,
        driver_id: driverId, served: [], notes: reservation.notes.trim(), is_pinned: true, pin_reason: "SADRAN_MANUAL" }, departmentId, weekStart });
      if (passengerMemberIds.length || reservation.childIds.length) {
        const passengers: RidePassengerInput[] = buildRidePassengerInputs(
          passengerMemberIds, reservation.childIds,
          reservationMembersQuery.data ?? [], reservationChildrenQuery.data ?? [],
        );
        try {
          // A brand-new ride's version always starts at 1 (`rides.version` default —
          // edit_ride()'s insert branch never touches it).
          await setRidePassengersMutation.mutateAsync({ rideId, expectedVersion: 1, passengers, departmentId, weekStart });
        } catch {
          toast.error(he.sadranBoard.reservationPeopleSaveFailed);
        }
      }
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

  async function handleRedo() {
    try {
      const result = await undoStack.redo();
      if (result) toast.success(tv("sadranBoard.redoToast", { label: result.label }));
      else toast(he.sadranBoard.redoNothing);
    } catch { /* Version conflicts are reported by the mutation. */ }
  }

  const selectedPlanningChange = (board.rideChangesQuery.data ?? []).find((change) => change.is_planning && `change:${change.id}` === selectedRideId);
  const selectedRide = rides.find((r) => r.id === (selectedPlanningChange?.ride_id ?? selectedRideId)) ?? null;
  const selectedRideDriverName = selectedRide?.driver_name ?? null;
  const selectedUnmet = board.unmetItems.find((item) => item.request.id === selectedUnmetId);
  const selectedWaitlistGroup = (board.waitlistGroupsQuery.data ?? []).find((group) => group.id === selectedGroupId) ?? null;

  return {
    selectedRideId,
    setSelectedRideId,
    selectedGroupId,
    setSelectedGroupId,
    selectedUnmetId,
    setSelectedUnmetId,
    carSwapPair,
    setCarSwapPair,
    mergePrefill,
    setMergePrefill,
    reservation,
    setReservation,
    seriesMoveConfirm,
    setSeriesMoveConfirm,
    unmetDragHover,
    setUnmetDragHover,
    editRideMutation,
    setRidePassengersMutation,
    claimDriverMutation,
    cancelRideChangeMutation,
    cancelRideMutation,
    unassignRideMutation,
    undoStack,
    reservationMembersQuery,
    reservationChildrenQuery,
    goToComposer,
    handlePlaceUnmetRequest,
    handleUnassignRide,
    handleRideClick,
    handleRideDrop,
    handleRideResize,
    handleUnmetDecision,
    saveReservation,
    handleUnmetAction,
    handleUndo,
    handleRedo,
    selectedPlanningChange,
    selectedRide,
    selectedRideDriverName,
    selectedUnmet,
    selectedWaitlistGroup,
  };
}
