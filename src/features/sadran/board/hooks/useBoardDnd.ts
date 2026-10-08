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
import { needsLargeTrunk } from "@/lib/luggageWaiver";
import { askSmallTrunk } from "@/lib/smallTrunk";
import { dateKey } from "@/lib/time";
import { useSession } from "@/features/auth/useSession";
import { useProfile } from "@/features/auth/useProfile";
import { useDepartmentMembers } from "@/features/auth/useDepartmentMembers";
import { fetchChildren } from "@/features/requests/api";

import { combineMergeLegs, defaultMergeLeg, mergeLegForCard, mergeLegOptions, mergePayload, mergePayloadFromLegs, mergePayloadLeg, mergePayloadLegs, mergeRefusalText, type MergeLeg } from "../mergeProposal";
import { isDropOffWithPickup, legView, unmetItemId, unmetItemKey } from "../unmetLegs";
import type { GuestDropTarget } from "@/components/GuestChips";
import { requestStart, requestWithinFlex } from "../phantomLanes";
import { reservationRoutePlaces, routeEditPayload, type RouteEditValues } from "../rideRouteEdit";
import { buildDraftInput, type ComposerPrefill } from "../draftInput";
import {
  carLocationAt,
  chauffeurCarElsewhere,
  connectsOtherLeg,
  isDropTargetValid,
  legStartPlaceId,
  minutesIso,
  originMismatch,
  passengersOf,
  privateCarBlocks,
  privateCarBlocksRide,
  seatsFit,
  luggageCountOf,
  luggageWarns,
  mergeRefusalReason,
  unavailable,
  unmetCandidateWindow,
  unmetPlacement,
  unmetRequestPassengers,
  unmetShiftPayload,
} from "../dropValidity";
import type { UnmetListItem } from "../components/UnmetList";
import { slotToIso, wouldOverlap } from "../geometry";
import { isReservation } from "@/features/rides/servedOf";
import { buildRidePassengerInputs, splitReservationDriverAndPassengers } from "../reservationPeople";
import {
  useCreateProposalMutation,
  useDiscardProposalMutation,
  useWhatsappTemplates,
  useWithdrawProposalMutation,
  useEditRideMutation,
  usePlaceSeriesOnCarMutation,
  useMarkCarMoveMutation,
  useSetRidePassengersMutation,
  useJoinDropOffLegsMutation,
  useUnassignRideMutation,
  useUnmergeRequestMutation,
  useCancelRideMutation,
} from "../../hooks";
import { useClaimRideDriverMutation, useCancelRideChangeMutation } from "@/features/rides/hooks";
import { fetchMergePreview, fetchRideVersion } from "../../api";
import { useUndoStack } from "../useUndoStack";
import { servedOf, servedToEditRideLegs } from "../../solverRun";

import type { BoardRide, EditRideInput, ProposalRow, RidePassengerInput, WeekRequestRow } from "../../api";
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
  const [mergePrefill, setMergePrefill] = useState<ComposerPrefill | null>(null);
  // REQ §13.94: every board popup that leads to the composer first offers "טיוטה" (store the
  // proposal unsent and stay on the board) next to "הכן הצעה" (open the composer).
  const [composeChoice, setComposeChoice] = useState<ComposerPrefill | null>(null);
  // Tapped draft block / sent merge ghost -> its action sheet (send, edit, discard / withdraw).
  const [selectedProposalId, setSelectedProposalId] = useState<string | null>(null);
  // memberIds: department members picked for the reservation, in pick order — the first
  // becomes the ride's driver (owner A5, 2026-09-14); the rest (plus childIds) become
  // `ride_passengers` rows via set_ride_passengers() once the ride itself is saved.
  const [reservation, setReservation] = useState<{ carId: string; start: string; end: string; notes: string; memberIds: string[]; childIds: string[]; kind: "reservation" | "move"; toPlaceId: string } | null>(null);
  // Multi-day request ("series") car-change confirmation (REQ §13.77, UX_FLOWS.md §4.2):
  // dragging a series leg onto a different car moves every day of the span — confirm first,
  // since a car free on this day only is not necessarily free for the whole series (MDR03).
  const [seriesMoveConfirm, setSeriesMoveConfirm] = useState<{ carName: string; index: number; count: number; run: () => Promise<void> } | null>(null);
  // Drag-an-unmet-card-onto-a-car-column (UX_FLOWS §20 item 3): live hover
  // state reported by `UnmetList`'s own pointer tracking (it owns the
  // gesture since the drag starts on its cards, outside the grid) — the
  // grid only needs to know which car to highlight and whether the drop
  // would be valid right now.
  // R3B5: a drop whose live preview was red (invalid target) is applied only after an explicit confirmation.
  const [invalidDropConfirm, setInvalidDropConfirm] = useState<{ run: () => Promise<void> } | null>(null);
  const [guestHover, setGuestHover] = useState<{ guest: { requestId: string; name: string }; target: GuestDropTarget | null } | null>(null);
  const [unmetDragHover, setUnmetDragHover] = useState<{ item: UnmetListItem; carId: string; minutes: number; hostRideId?: string } | null>(null);

  const createProposalMutation = useCreateProposalMutation();
  const discardProposalMutation = useDiscardProposalMutation();
  const withdrawProposalMutation = useWithdrawProposalMutation();
  const templatesQuery = useWhatsappTemplates();
  const profileQuery = useProfile();
  const editRideMutation = useEditRideMutation();
  const placeSeriesMutation = usePlaceSeriesOnCarMutation();
  const markCarMoveMutation = useMarkCarMoveMutation();
  const setRidePassengersMutation = useSetRidePassengersMutation();
  const claimDriverMutation = useClaimRideDriverMutation();
  const cancelRideChangeMutation = useCancelRideChangeMutation();
  const cancelRideMutation = useCancelRideMutation();
  const unassignRideMutation = useUnassignRideMutation();
  const joinLegsMutation = useJoinDropOffLegsMutation();
  const unmergeRequestMutation = useUnmergeRequestMutation();
  const undoStack = useUndoStack<void>();
  // REQ §13.111 (a): "צריך תא מטען גדול ... לשבץ בכל זאת?" - asked before a hand placement that would put a
  // large-luggage request on a car without a large trunk (the server stays the decider: `needs_large_trunk`;
  // a refusal it still raises is answered by the same dialog in `lib/smallTrunk.ts` `withSmallTrunkRetry`).
  /** Resolves `true` when no waiver is needed (or the Sadran accepted it), `false` when declined. `waived` = the flag to send. */
  async function confirmSmallTrunk(carId: string, people: readonly { requestId: string | null; name: string | null | undefined }[]): Promise<{ ok: boolean; waived: boolean }> {
    if (people.length === 0 || !luggageWarns(dropCtx, carId, people.length)) return { ok: true, waived: false };
    const car = carsData.find((c) => c.id === carId);
    const accepted = await askSmallTrunk({
      requestIds: people.flatMap((person) => (person.requestId ? [person.requestId] : [])),
      names: people.map((person) => person.name ?? ""),
      carId,
      carName: car?.name ?? null,
    });
    return { ok: accepted, waived: accepted };
  }
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

  const { selectedDay, dayStartIso, dropCtx, rides } = board;
  const requestsData = board.requestsQuery.data ?? [];
  const carsData = board.carsQuery.data ?? [];
  const department = board.department;

  /** Opens the composer (the old `goToComposer`); `proposalId` set = view/send that existing proposal. */
  function openComposer(prefill: ComposerPrefill) {
    navigate(paths.sadran.composer(departmentId, weekStart), { state: { ...prefill, returnTo: location.pathname + location.search } });
  }

  /**
   * Every board path that leads to a suggestion goes through here: an existing proposal opens
   * directly, a new one first asks "טיוטה" / "הכן הצעה" (REQ §13.94).
   */
  function goToComposer(prefill: ComposerPrefill) {
    if (prefill.proposalId) { openComposer(prefill); return; }
    setComposeChoice(prefill);
  }

  /** "טיוטה": `create_proposal` with the payload and text the composer would have built; stays on the board. */
  async function saveDraft(prefill: ComposerPrefill) {
    // R5B5: the draft's stored text reads the server's merge preview, like the popup and the composer.
    const serverMerge = prefill.type === "merge" && prefill.rideId
      ? await fetchMergePreview(prefill.rideId, prefill.requestId, mergePayloadLeg(prefill.payload, requestsData.find((r) => r.id === prefill.requestId) ?? { trip_shape: "round_trip" })).catch(() => null)
      : null;
    const built = buildDraftInput(prefill, {
      requests: requestsData,
      rides,
      templates: templatesQuery.data ?? [],
      destinations: board.destinationsQuery.data ?? [],
      cars: carsData,
      sadranName: profileQuery.data?.full_name ?? "",
      homeDestinationId: department?.home_destination_id,
      route: board.routeCtx,
      serverMerge,
    });
    if (!built.ok) { toast.error(he.boardDrafts.cannotDraft); return; }
    try {
      await createProposalMutation.mutateAsync({ ...built.input, departmentId, weekStart });
      setComposeChoice(null);
      setMergePrefill(null);
      toast.success(he.boardDrafts.saved);
    } catch {
      // the mutation already showed the error toast; keep the popup open
    }
  }

  function composeFromChoice() {
    const choice = composeChoice;
    setComposeChoice(null);
    if (choice) openComposer(choice);
  }

  const proposals: ProposalRow[] = board.proposalsQuery.data ?? [];
  const selectedProposal = proposals.find((p) => p.id === selectedProposalId) ?? null;

  /** REQ §13.94 (G10): the popup's "הלוך בלבד" / "הלוך וחזור" choice rewrites the merge payload's leg. */
  function setMergeLeg(leg: MergeLeg) {
    setMergePrefill((prev) => {
      if (!prev?.rideId) return prev;
      // R3B11: a split merge (legs on two rides) keeps the other ride's leg; only the dropped-on ride's leg changes.
      const legs = mergePayloadLegs(prev.payload);
      const target = prev.legRideId ?? prev.rideId;
      if (new Set(legs.map((entry) => entry.ride_id)).size > 1) {
        return { ...prev, payload: mergePayloadFromLegs(legs.map((entry) => (entry.ride_id === target ? { ...entry, leg } : entry))) };
      }
      return { ...prev, payload: mergePayload(prev.rideId, leg) };
    });
  }

  /**
   * Opens the merge popup for `requestId` joining `hostRideId` on `leg`. REQ §13.102 (d, R2M2/R2B13):
   * when the request already has an open merge draft, the new leg extends it (out on ride A + return
   * on ride B, one proposal) instead of replacing it silently.
   */
  function openMerge(requestId: string, hostRideId: string, leg: MergeLeg, anchorLeg: "out" | "return" | null) {
    // The server extends an open draft or a sent, unanswered merge (REQ §13.102 d) - mirror it.
    const prev = proposals.find((p) => p.type === "merge" && (p.status === "draft" || p.status === "sent") && p.request_id === requestId);
    let payload = mergePayload(hostRideId, leg);
    let draftNote: "extends" | "replaces" | null = null;
    if (prev) {
      const prevLegs = mergePayloadLegs(prev.payload);
      const existing = prevLegs.length ? prevLegs : prev.ride_id ? [{ ride_id: prev.ride_id, leg: "both" as MergeLeg }] : [];
      const combined = combineMergeLegs(existing, { ride_id: hostRideId, leg });
      payload = mergePayloadFromLegs(combined.legs);
      draftNote = combined.replaced ? "replaces" : "extends";
    }
    setMergePrefill({ requestId, rideId: payload.ride_id as string, type: "merge", payload, anchorLeg, draftNote, legRideId: hostRideId });
  }

  /**
   * REQ item 108 (R7B4): the TS twin refused a drop - the server decides (`merge_preview`, per leg). Returns the leg (and the
   * card anchor) to open the popup on: the preferred leg when the server accepts it, else the first leg it accepts
   * (a round trip whose "both" is too long may still ride "חזור" alone); `null` + a toast with the server's own reason when
   * no leg is allowed. A failed preview call falls back to the preferred leg (the popup then shows the twin's verdict).
   */
  async function serverMergeLeg(hostId: string, req: WeekRequestRow, preferred: MergeLeg, anchor: "out" | "return" | null): Promise<{ leg: MergeLeg; anchor: "out" | "return" | null } | null> {
    const preset = mergeLegOptions(req).preset;
    const order: MergeLeg[] = preset ? [preset] : [...new Set<MergeLeg>([preferred, "both", "out", "return"])];
    let firstRefusal: string | null = null;
    for (const leg of order) {
      let server;
      try { server = await fetchMergePreview(hostId, req.id, leg); } catch { return { leg: preferred, anchor }; }
      if (!server) return { leg: preferred, anchor };
      if (server.ok || server.waivable) return { leg, anchor: leg === "return" ? "return" : leg === "out" && anchor === "return" ? null : anchor };
      firstRefusal ??= mergeRefusalText(server.code, server.turnaroundSide);
    }
    toast.error(firstRefusal ?? he.mergedRide.invalid.unknown);
    return null;
  }

  /**
   * REQ §13.94 (G10): take an added person out of a merged ride. A draft merge is discarded, a
   * sent/accepted one withdrawn, an applied one un-merged (`unmerge_request`: the request returns
   * to the unmet list and the person is notified).
   */
  async function removeAddedPerson(rideId: string, requestId: string, name: string): Promise<boolean> {
    const ride = rides.find((r) => r.id === rideId);
    const pending = proposals.find((p) => p.type === "merge" && p.request_id === requestId && p.ride_id === rideId && ["draft", "sent", "accepted"].includes(p.status));
    try {
      if (pending?.status === "draft") await discardProposalMutation.mutateAsync({ proposalId: pending.id, departmentId, weekStart });
      else if (pending) await withdrawProposalMutation.mutateAsync({ proposalId: pending.id, departmentId, weekStart });
      else if (ride?.version != null) await unmergeRequestMutation.mutateAsync({ rideId, requestId, expectedVersion: ride.version, departmentId, weekStart });
      else return false;
      setSelectedRideId(null);
      toast.success(tv("mergedRide.removed", { name }));
      return true;
    } catch { /* toast shown by the mutation */ return false; }
  }

  /**
   * REQ §13.94 (G10): a guest chip was dragged off a merged block. Dropped on the unmet list / a
   * phantom lane: unmerge only. Dropped on a car (or onto another ride): unmerge first, then the
   * ordinary unmet placement / merge path for that request at the drop point.
   */
  async function handleGuestDrop(guest: { requestId: string; rideId: string; name: string }, target: GuestDropTarget) {
    setGuestHover(null);
    const removed = await removeAddedPerson(guest.rideId, guest.requestId, guest.name);
    if (!removed || target.kind === "unmet") return;
    const request = board.boardRequests.find((r) => r.id === guest.requestId);
    if (!request) return;
    const servedLeg = rides.flatMap((ride) => servedOf(ride)).find((entry) => entry.request_id === guest.requestId)?.leg;
    const view = isDropOffWithPickup(request) && (servedLeg === "out" || servedLeg === "return") ? legView(request, servedLeg) : request;
    await handlePlaceUnmetRequest({ request: view, leg: undefined, destinationName: request.destination_resolved_name ?? "—" }, target.carId, target.minutes, target.hostRideId);
  }

  /**
   * REQ §13.94 (G8): save the ride sheet's "מסלול" section. A ride serving a member's request goes
   * through a `shift` proposal (draft or compose); a Sadran reservation uses `edit_ride` directly.
   */
  async function saveRideRoute(ride: BoardRide, values: RouteEditValues) {
    if (!ride.id) return;
    const served = servedOf(ride);
    const base = served.find((entry) => entry.role === "driver") ?? served[0];
    if (base?.request_id) {
      setSelectedRideId(null);
      goToComposer({ requestId: base.request_id, rideId: ride.id, type: "shift", payload: routeEditPayload(ride.id, values) });
      return;
    }
    const places = reservationRoutePlaces(values);
    if (!places || !ride.car_id || !ride.starts_at || !ride.ends_at) { toast.error(he.rideRouteEdit.presetOnly); return; }
    try {
      await editRideMutation.mutateAsync({
        input: {
          id: ride.id, department_id: departmentId, week_start: weekStart, car_id: ride.car_id,
          starts_at: ride.starts_at, ends_at: ride.ends_at,
          origin_id: places.originId, destination_id: places.destinationId,
          driver_id: ride.driver_id, needs_driver: !!ride.needs_driver, notes: ride.notes ?? undefined,
          is_pinned: !!ride.is_pinned, pin_reason: ride.pin_reason, allow_conflict: true,
          served: servedToEditRideLegs(served),
        },
        expectedVersion: ride.version ?? undefined, departmentId, weekStart,
      });
      setSelectedRideId(null);
      toast.success(he.rideRouteEdit.saved);
    } catch { /* toast shown by the mutation */ }
  }

  /** "שלח" on a draft: the composer on that draft, whose send is the existing `send_proposal`. */
  function sendDraft(proposal: ProposalRow) {
    setSelectedProposalId(null);
    openComposer({ requestId: proposal.request_id as string, rideId: proposal.ride_id, type: proposal.type, payload: (proposal.payload ?? {}) as Record<string, unknown>, proposalId: proposal.id });
  }

  /** "ערוך": the composer editable again, prefilled from the draft; saving supersedes the old draft. */
  function editDraft(proposal: ProposalRow) {
    setSelectedProposalId(null);
    openComposer({ requestId: proposal.request_id as string, rideId: proposal.ride_id, type: proposal.type, payload: (proposal.payload ?? {}) as Record<string, unknown> });
  }

  async function discardDraft(proposal: ProposalRow) {
    try {
      await discardProposalMutation.mutateAsync({ proposalId: proposal.id, departmentId, weekStart });
      setSelectedProposalId(null);
      toast.success(he.boardDrafts.discarded);
    } catch { /* toast shown by the mutation */ }
  }

  async function withdrawSent(proposal: ProposalRow) {
    try {
      await withdrawProposalMutation.mutateAsync({ proposalId: proposal.id, departmentId, weekStart });
      setSelectedProposalId(null);
      toast.success(he.boardDrafts.withdrawn);
    } catch { /* toast shown by the mutation */ }
  }

  /** Assign a request leg or prepare a proposal when sharing/relay coordination is required. */
  async function handlePlaceUnmetRequest(item: UnmetListItem, carId: string, minutes: number, droppedOnRideId?: string) {
    setUnmetDragHover(null);
    const req = item.request;
    if (carId.startsWith("phantom:")) return;
    if (!requestStart(req) || dateKey(requestStart(req)!) !== selectedDay) {
      toast.error(he.sadranBoard.wrongDay); return;
    }
    if (privateCarBlocks(dropCtx, carId, req.requester_id)) { toast.error(he.sadranBoard.privateCarNotTarget); return; }
    // R2B7: a drop on a draft block is refused; a drop on a pending-merge block means its ride.
    if (droppedOnRideId?.startsWith("draft:")) { toast.error(he.sadranBoard.dropOnDraftBlock); return; }
    if (droppedOnRideId?.startsWith("merge:")) {
      droppedOnRideId = proposals.find((p) => p.id === droppedOnRideId!.slice(6))?.ride_id ?? undefined;
    }
    // REQ §13.111 (a): a large-luggage request on a car without a large trunk - ask first, send the waiver with the placement.
    const waiver = { allowSmallTrunk: false };
    const askSmallTrunk = async (): Promise<boolean> => {
      if (!needsLargeTrunk(req)) return true;
      const asked = await confirmSmallTrunk(carId, [{ requestId: req.id, name: req.requester_full_name }]);
      waiver.allowSmallTrunk = asked.waived;
      return asked.ok;
    };
    // OB1: a multi-day request is placed whole - every day on this car; the server refuses when the
    // car is not free on all of them (`series_car_unavailable`).
    if (req.series_id && !droppedOnRideId) {
      if (!(await askSmallTrunk())) return;
      try {
        await placeSeriesMutation.mutateAsync({ seriesId: req.series_id, carId, allowSmallTrunk: waiver.allowSmallTrunk, departmentId, weekStart });
        toast.success(he.sadranBoard.seriesPlaced);
      } catch { /* The mutation shows the error. */ }
      return;
    }
    let window = unmetCandidateWindow(dropCtx, item, minutes, false, carId);
    if (!window || !department?.home_destination_id) {
      toast.error(he.sadranBoard.invalidWindow);
      return;
    }
    // R2B7: a drop ON a ride (any trip type) is a merge attempt: the merge flow when valid, else the reason.
    const dropHost = droppedOnRideId ? rides.find((ride) => ride.id === droppedOnRideId && ride.status !== "cancelled" && ride.car_id === carId && !servedOf(ride).some((entry) => entry.request_id === req.id)) : undefined;
    if (dropHost?.id && dropHost.starts_at && dropHost.ends_at) {
      if (isReservation(dropHost)) { toast.error(he.sadranBoard.dropOnReservation); return; }
      // R3B20: a round-trip guest (no preset leg, not a single-leg card) joins both legs when both fit.
      let mergeLeg = mergeLegForCard(req, item.leg ?? null);
      if (!item.leg && !mergeLegOptions(req).preset && mergeRefusalReason(dropCtx, dropHost, req, "both") === null) mergeLeg = "both";
      const refusal = mergeRefusalReason(dropCtx, dropHost, req, mergeLeg);
      if (refusal === "private_car") { toast.error(he.mergedRide.invalid[refusal]); return; }
      let openLeg = mergeLeg;
      let openAnchor: "out" | "return" | null = item.leg ?? null;
      if (refusal) {
        // R7B4: the twin is only advisory - the server's per-leg verdict decides whether (and on which leg) the popup opens.
        const chosen = await serverMergeLeg(dropHost.id, req, mergeLeg, openAnchor);
        if (!chosen) return;
        openLeg = chosen.leg; openAnchor = chosen.anchor;
      }
      // REQ §13.94 (G10): the popup shows the merged ride; the payload is legs only (the host keeps its start).
      openMerge(req.id, dropHost.id, openLeg, openAnchor);
      return;
    }
    const connects = connectsOtherLeg(dropCtx, item, carId);
    window = unmetCandidateWindow(dropCtx, item, minutes, !connects, carId);
    if (!window) { toast.error(he.sadranBoard.invalidWindow); return; }
    if (unavailable(dropCtx, carId, window.startsAt, window.endsAt)) { toast.error(he.sadranBoard.maintenanceUnavailable); return; }
    // R2B7: never create a ride that overlaps another ride on the car (reservations and blocks included).
    if (wouldOverlap(window, rides.filter((ride) => ride.car_id === carId && ride.status !== "cancelled" && ride.starts_at && ride.ends_at)
      .map((ride) => ({ startsAt: ride.starts_at!, endsAt: ride.ends_at! })), 0)) {
      // R7B10: a plain placement (nothing to merge into) - never worded as a merged ride.
      toast.error(he.sadranBoard.placementOverlap); return;
    }
    if (!seatsFit(dropCtx, carId, connects ? { adults: req.adults, childSeats: req.child_seats, boosters: req.boosters } : unmetRequestPassengers(req))) {
      toast.error(he.sadranBoard.dragInvalidSeatsToast);
      return;
    }
    // QB23: the car must be at the request's origin when the window starts - refuse instead of
    // offering a shift/placement onto a car parked elsewhere (a connected pair's own other leg is exempt).
    const dropOrigin = legStartPlaceId(req, dropCtx.homeDestinationId);
    if (!connects && dropOrigin && originMismatch(dropCtx, carId, dropOrigin, window.startsAt)) {
      toast.error(he.sadranBoard.carNotAtOriginToast); return;
    }
    if (!connects && chauffeurCarElsewhere(dropCtx, req, carId, window.startsAt)) {
      toast.error(he.sadranBoard.carNotAtOriginToast); return;
    }
    // Placement by the member-facing trip type and the request's own places (REQ §13.93).
    const placement = unmetPlacement(dropCtx, req, carId, window.startsAt);
    if (!placement) { toast.error(he.sadranBoard.invalidWindow); return; }
    if (!(await askSmallTrunk())) return;
    if (!requestWithinFlex(req, window.startsAt, window.endsAt)) {
      goToComposer({ requestId: req.id, rideId: null, type: "shift", payload: { ...unmetShiftPayload(req, carId, window, placement, item.leg), ...(waiver.allowSmallTrunk ? { allow_small_trunk: true } : {}) } });
      return;
    }
    try {
      const placeInput: EditRideInput = {
        department_id: departmentId,
        week_start: weekStart,
        car_id: carId,
        starts_at: window.startsAt,
        ends_at: window.endsAt,
        origin_id: placement.originId,
        destination_id: placement.destinationId,
        driver_id: placement.driverIsRequester ? req.requester_id : null,
        needs_driver: !placement.driverIsRequester,
        allow_conflict: true,
        is_pinned: true,
        pin_reason: "SADRAN_MANUAL",
        served: [{ request_id: req.id, ...placement.served }],
        ...(waiver.allowSmallTrunk ? { allow_small_trunk: true } : {}),
      };
      let placedRideId = await editRideMutation.mutateAsync({ input: placeInput, departmentId, weekStart });
      // R2B7: undo works after a drop from the unmet list - it takes the placed ride back out (the request returns to the list).
      undoStack.push({
        label: req.requester_full_name ?? placedRideId,
        run: async () => {
          const expectedVersion = await fetchRideVersion(placedRideId);
          await unassignRideMutation.mutateAsync({ rideId: placedRideId, expectedVersion, departmentId, weekStart });
        },
        redo: async () => { placedRideId = await editRideMutation.mutateAsync({ input: placeInput, departmentId, weekStart }); },
      });
      const carName = carsData.find((c) => c.id === carId)?.name ?? "";
      toast.success(placement.driverIsRequester ? tv("sadranBoard.dragPlacedToast", { car: carName, start: formatMinutes(minutes) }) : connects ? he.connectedPair.saved : he.boardCoordination.standaloneSaved);
    } catch {
      // The mutation reports validation errors; keep the request on its phantom lane.
    }
  }

  /** Return every served request to the unmet board atomically. */
  /** REQ §13.105 c: "חבר לנסיעה אחת" - the drop-off ride and the pickup ride of one request become one ride. */
  async function handleJoinLegs(rideId: string, requestId: string) {
    const ride = rides.find((r) => r.id === rideId);
    if (!ride?.version) return;
    try {
      await joinLegsMutation.mutateAsync({ requestId, rideId, expectedVersion: ride.version, departmentId, weekStart });
      toast.success(he.sadranBoard.legsJoinedToast);
    } catch {
      // toast already shown by the mutation
    }
  }

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
    // A draft block, or a sent/accepted merge ghost: its action sheet (REQ §13.94).
    if (id.startsWith("merge:")) { setSelectedProposalId(id.slice(6)); return; }
    if (id.startsWith("draft:")) { setSelectedProposalId(id.slice(6)); return; }
    // A ride with a sent/accepted shift proposal waiting for an answer: its proposal sheet (withdraw) (REQ §13.94).
    const awaiting = proposals.find((p) => p.type === "shift" && p.ride_id === id && (p.status === "sent" || p.status === "accepted"));
    if (awaiting) { setSelectedProposalId(awaiting.id); return; }
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
      const item = board.unmetItems.find((item) => unmetItemId(item) === rideId);
      if (item) await handlePlaceUnmetRequest(item, carId, startMinutes, droppedOnRideId);
      return;
    }
    if (carId.startsWith("phantom:")) { await handleUnassignRide(rideId); return; }
    const ride = rides.find((r) => r.id === rideId);
    if (!ride?.id || !ride.starts_at || !ride.ends_at || !ride.car_id || !ride.origin_id || !ride.destination_id) return;

    if (privateCarBlocksRide(dropCtx, ride, carId) || (droppedOnRideId && droppedOnRideId !== rideId && ride.needs_driver
      && privateCarBlocks(dropCtx, carId, servedOf(ride).map((e) => requestsData.find((r) => r.id === e.request_id)).find((r) => r)?.requester_id))) {
      toast.error(he.sadranBoard.privateCarNotTarget); return;
    }
    // R3B2: a needs-driver ride dropped on another ride is always a merge attempt (the host may itself
    // need a driver: refused below), never a plain move.
    if (ride.needs_driver && droppedOnRideId && droppedOnRideId !== rideId && rides.some((other) => other.id === droppedOnRideId && other.car_id === carId)) {
      const driverEntry = servedOf(ride).find((s) => s.role === "driver") ?? servedOf(ride)[0];
      if (driverEntry?.request_id) {
        const host = rides.find((candidate) => candidate.id === droppedOnRideId);
        if (!host?.starts_at || !host.ends_at) return;
        if (!host.driver_id || host.needs_driver) { toast.error(he.boardCoordination.mergeNeedsDriver); return; }
        const guestRequest = requestsData.find((r) => r.id === driverEntry.request_id);
        const invalidMerge = guestRequest ? mergeRefusalReason(dropCtx, host, guestRequest, driverEntry.leg ?? "both", [ride.id]) : null;
        if (invalidMerge === "private_car") { toast.error(he.mergedRide.invalid[invalidMerge]); return; }
        let openLeg: MergeLeg = driverEntry.leg ?? "both";
        let openAnchor: "out" | "return" | null = driverEntry.leg === "return" ? "return" : driverEntry.leg === "out" ? "out" : null;
        if (invalidMerge && guestRequest) {
          const chosen = await serverMergeLeg(droppedOnRideId, guestRequest, openLeg, openAnchor);
          if (!chosen) return;
          openLeg = chosen.leg; openAnchor = chosen.anchor;
        }
        openMerge(driverEntry.request_id, droppedOnRideId, openLeg, openAnchor);
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
    const withinDepartFlex = servedRequests.every((req) => requestWithinFlex(req, newStartsAt, newEndsAt, servedOf(ride).find((entry) => entry.request_id === req.id)?.leg, ride.driver_id !== req.requester_id));

    // Conflicts checked and reported in Hebrew *before* touching the DB
    // (owner bug report #2): overlap/buffer, maintenance and seat fit are checked here against the
    // *real* dropped time as an instant, advisory pre-check - the server re-checks on write
    // (`rides_before_write`, `assert_ride_seats_fit`) and its error is shown if it disagrees.
    // Location (the car chain) is NOT enforced: `assert_car_chain` inside `edit_ride` heals what it
    // can and `flag_car_chain_breaks` only flags the rest (a board warning, never a refusal).
    if (carId !== ride.car_id && !seatsFit(dropCtx, carId, passengersOf(ride))) {
      toast.error(he.sadranBoard.seatMismatchToast);
      return;
    }
    // REQ §13.111 (a): moving a ride with large luggage onto a car without a large trunk asks first.
    let allowSmallTrunk = false;
    if (carId !== ride.car_id && luggageCountOf(ride) > 0) {
      const asked = await confirmSmallTrunk(carId, servedOf(ride).filter((entry) => entry.luggage && !entry.luggage_waived).map((entry) => ({ requestId: entry.request_id, name: entry.requester })));
      if (!asked.ok) return;
      allowSmallTrunk = asked.waived;
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
        ...(allowSmallTrunk ? { allow_small_trunk: true } : {}),
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
      // R3B5: the live preview was red -> never apply silently.
      if (!isDropTargetValid(dropCtx, rideId, carId, startMinutes, newEndMinutes, droppedOnRideId)) {
        setInvalidDropConfirm({ run: applyMove });
        return;
      }
      await applyMove();
    } else if (driverRequest) {
      toast(he.sadranBoard.dragBeyondFlexToast);
      goToComposer({
        requestId: driverRequest.id,
        rideId: ride.id,
        type: "shift",
        payload: { car_id: carId, depart_at: newStartsAt, return_at: newEndsAt, origin_id: ride.origin_id, destination_id: ride.destination_id, ride_id: ride.id, ...(allowSmallTrunk ? { allow_small_trunk: true } : {}) },
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
    if (reservation.kind === "move") {
      // REQ §13.103 b: from = where the car is at that time (never typed), to = the picked place.
      const atIso = start == null ? null : minutesIso(dropCtx, start);
      const fromPlaceId = atIso ? carLocationAt(dropCtx, reservation.carId, atIso) : null;
      if (start == null || end == null || end <= start || !atIso || !fromPlaceId || !reservation.toPlaceId) { toast.error(he.sadranBoard.invalidWindow); return; }
      try {
        await markCarMoveMutation.mutateAsync({ carId: reservation.carId, fromPlaceId, toPlaceId: reservation.toPlaceId, at: atIso, minutes: end - start, peopleIds: reservation.memberIds, departmentId, weekStart });
        setReservation(null); toast.success(he.sadranBoard.carMoveSaved);
      } catch { /* the mutation shows the error */ }
      return;
    }
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
        // REQ §13.105 / QA run 6 R5B3: the card's own car (and, on one card of a split הקפצה, its leg) goes with the
        // shift, so accepting it places exactly that leg on that car (`_shift_place_on_car`) instead of leaving it unmet.
        goToComposer({
          requestId: item.request.id, rideId: null, type: "shift",
          payload: dropCtx.weekStartMs != null
            ? unmetShiftPayload(item.request, suggestion.carId, {
              startsAt: slotToIso(suggestion.window.start, dropCtx.weekStartMs), endsAt: slotToIso(suggestion.window.end, dropCtx.weekStartMs),
            }, undefined, item.leg)
            : { car_id: suggestion.carId, ...(item.leg ? { leg: item.leg } : {}) },
        });
        return;
      case "convertToRoundTrip":
        goToComposer({ requestId: item.request.id, rideId: null, type: "shift", payload: {} });
        return;
      case "merge":
        // REQ §13.94: the suggestion path builds the same full payload as the drag path.
        goToComposer({ requestId: item.request.id, rideId: suggestion.hostRideId, type: "merge", payload: mergePayload(suggestion.hostRideId, defaultMergeLeg(item.request)) });
        return;
      case "splitLegs":
        goToComposer({ requestId: item.request.id, rideId: null, type: "merge", payload: {} });
        return;
      case "externalHint":
        goToComposer({ requestId: item.request.id, rideId: null, type: "external", payload: { hint: suggestion.hint } });
        return;
      case "deny":
        goToComposer({ requestId: item.request.id, rideId: null, type: "deny", payload: {} });
        return;
      case "chainOneWay":
        // REQ §13.105 a: two members' complementary one-way legs - the Sadran sends a shift onto the car
        // left at X (SOLVER §3.15); never placed automatically.
        goToComposer({
          requestId: item.request.id, rideId: null, type: "shift",
          payload: { car_id: suggestion.carId, ...(dropCtx.weekStartMs != null ? { depart_at: slotToIso(suggestion.window.start, dropCtx.weekStartMs) } : {}) },
        });
        return;
      case "useAlternative":
        // REQ §13.112 (a): the member's plan B as a proposal of type `alternative` (SOLVER §3.15) - the Sadran sends or
        // drafts it; never automatic. The cars and the member's own two times; the plan's places come from the row.
        if (dropCtx.weekStartMs == null) return;
        goToComposer({
          requestId: item.request.id, rideId: null, type: "alternative",
          payload: {
            car_id: suggestion.carId,
            ...(suggestion.returnCarId ? { return_car_id: suggestion.returnCarId } : {}),
            depart_at: slotToIso(suggestion.departSlot, dropCtx.weekStartMs),
            ...(suggestion.returnSlot != null ? { return_at: slotToIso(suggestion.returnSlot, dropCtx.weekStartMs) } : {}),
          },
        });
        return;
      case "changeOrigin":
        // REQUIREMENTS §13.93 (ORIGINS_PLAN §3 "O4b"): the solver's "car free at a different
        // place" suggestion becomes an `origin` proposal — same send-from-the-board path as
        // every other suggestion kind (SOLVER §3.15).
        goToComposer({ requestId: item.request.id, rideId: null, type: "origin", payload: { origin_id: suggestion.originId, car_id: suggestion.carId } });
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

  // REQ §13.103 b: the car-move dialog shows where the car is at the chosen start time.
  const reservationStart = reservation ? parseHHMM(reservation.start) : null;
  const reservationFromId = reservation && reservationStart != null ? carLocationAt(dropCtx, reservation.carId, minutesIso(dropCtx, reservationStart)) : null;
  const reservationFromName = reservationFromId ? (board.destinationsQuery.data ?? []).find((d) => d.id === reservationFromId)?.name ?? null : null;

  const selectedPlanningChange = (board.rideChangesQuery.data ?? []).find((change) => change.is_planning && `change:${change.id}` === selectedRideId);
  const selectedRide = rides.find((r) => r.id === (selectedPlanningChange?.ride_id ?? selectedRideId)) ?? null;
  const selectedRideDriverName = selectedRide?.driver_name ?? null;
  const selectedUnmet = board.unmetItems.find((item) => unmetItemKey(item) === selectedUnmetId);
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
    setMergeLeg,
    removeAddedPerson,
    handleGuestDrop,
    guestHover,
    setGuestHover,
    saveRideRoute,
    composeChoice,
    setComposeChoice,
    selectedProposal,
    setSelectedProposalId,
    reservation,
    setReservation,
    seriesMoveConfirm,
    setSeriesMoveConfirm,
    invalidDropConfirm,
    setInvalidDropConfirm,
    unmetDragHover,
    setUnmetDragHover,
    editRideMutation,
    markCarMoveMutation,
    reservationFromName,
    reservationFromId,
    setRidePassengersMutation,
    claimDriverMutation,
    cancelRideChangeMutation,
    cancelRideMutation,
    unassignRideMutation,
    handleJoinLegs,
    unmergeRequestMutation,
    undoStack,
    reservationMembersQuery,
    reservationChildrenQuery,
    goToComposer,
    openComposer,
    saveDraft,
    composeFromChoice,
    sendDraft,
    editDraft,
    discardDraft,
    withdrawSent,
    draftPending: createProposalMutation.isPending,
    proposalActionPending: discardProposalMutation.isPending || withdrawProposalMutation.isPending || unmergeRequestMutation.isPending,
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
