import { useActiveDepartment } from "@/features/auth/useActiveDepartment";
import { ChevronDown, Inbox, MessageCircleQuestion, CarFront } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { toast } from "sonner";

import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { EmptyState } from "@/components/EmptyState";
import { ErrorState } from "@/components/ErrorState";
import { PageHeader } from "@/components/PageHeader";
import { RideCard } from "@/components/RideCard";
import { CardListSkeleton } from "@/components/skeletons/CardListSkeleton";
import { StatusBadge } from "@/components/StatusBadge";
import { formatWeekRangeLabel } from "@/components/dateFieldDates";
import { useProfile } from "@/features/auth/useProfile";
import { DeviceSetupPrompts } from "@/features/member/components/DeviceSetupPrompts";
import { useMyResponsibleCarsQuery } from "@/features/cars/hooks";
import { isRideRelated, relatedRequestIdToEdit } from "@/features/rides/relatedRide";
import { useCars, useMyTemporaryCars, useRideTypes } from "@/features/fleet/hooks";
import { AddRideFab } from "@/features/requests/components/AddRideFab";
import { CarNowButton } from "@/features/requests/components/CarNowButton";
import { NewRequestButton } from "@/features/requests/components/NewRequestButton";
import { RequestRow } from "@/features/requests/components/RequestRow";
import { ShortenSeriesDialog } from "@/features/requests/components/ShortenSeriesDialog";
import { TemplateSuggestions } from "@/features/requests/components/TemplateSuggestions";
import {
  useCancelRideMutation,
  usePlaceOnOwnCarMutation,
  useRestoreDuplicateMutation,
  useClaimFreedSlotMutation,
  useMyFreedSlotOffers,
  useMyRequests,
  useSetFreedSlotOptOutMutation,
  useWithdrawAllRequestsMutation,
  useWithdrawFreedSlotClaimMutation,
  useWithdrawRequestMutation,
} from "@/features/requests/hooks";
import type { MyRequestRow } from "@/features/requests/api";
import { canEditRequest, isPublishedDayWindow } from "@/features/requests/window";
import {
  confirmDialogDescription,
  confirmDialogLabel,
  confirmDialogTitle,
  requestStart,
  toDisplayRows,
  displayStatus,
  type DisplayRow,
  type ConfirmAction,
} from "@/features/requests/myRequestsRows";
import { buildTripWeeks, ridesByRequestRow } from "@/features/requests/myTrips";
import { isTodayOrLater } from "@/features/requests/upcoming";
import { useCollapsedWeeks } from "@/features/requests/useCollapsedWeeks";
import { useBoardRides, useWeeks, useMyUpcomingRides, useMyChildrenQuery, useMyChildrenRidesQuery, useMyCoGuardiansQuery } from "@/features/siddur/hooks";
import { useCarNeighboursQuery, useRideChanges, useRemoveRidePassengerMutation, useRequestRideChangeMutation } from "@/features/rides/hooks";
import { isRideDayEditable } from "@/features/rides/rideDayEditable";
import { useRideSheetCarActions } from "@/features/rides/useRideSheetCarActions";
import { myRidePersonKey } from "@/features/rides/ridePeople";
import { isRideOfMine, selectRelatedRides } from "@/features/rides/myRides";
import { RideDetailSheet } from "@/features/siddur/components/RideDetailSheet";
import { MemberRideEditor } from "@/features/siddur/components/MemberRideEditor";
import type { BoardRide } from "@/features/siddur/api";
import type { RideMove } from "@/features/rides/api";
import { myRideCard } from "@/features/siddur/myRideCard";
import { rowHandover, rowHandoverRideIds } from "@/features/requests/rowHandover";
import { conflictingRides } from "@/features/siddur/rideEditing";
import { useDepartmentSettings, useEditRideMutation } from "@/features/sadran/hooks";
import { servedOf } from "@/features/rides/servedOf";
import { OpenProposalButton } from "@/features/proposals/components/OpenProposalButton";
import { useOpenProposal } from "@/features/proposals/useOpenProposal";
import { MyWeekItemSheet } from "@/features/requests/myWeek/MyWeekItemSheet";
import { MyWeekView } from "@/features/requests/myWeek/MyWeekView";
import type { MyWeekTarget } from "@/features/requests/myWeek/myWeekItems";
import type { TemplateSuggestion } from "@/features/requests/api";
import { TemplateSuggestionActions } from "@/features/requests/components/TemplateSuggestions";
import { TripSummary } from "@/components/TripSummary";
import { useMyDisplayPrefs } from "@/features/requests/myWeek/myDisplayPrefs";
import { useTightRideIds } from "@/features/requests/myWeek/useTightRideIds";
import { MyWeekDisplayMenu } from "@/features/requests/myWeek/MyWeekDisplayMenu";
import { he, t, tv } from "@/i18n/he";
import { describeStatusReason } from "@/lib/statusReason";
import { effectiveWeekSettings } from "@/lib/weekSettings";
import { formatTime } from "@/lib/time";
import { cn } from "@/lib/utils";
import { paths } from "@/app/routes";

import { isAwaitingAnswer } from "@/features/requests/pendingProposal";
import { hasRideTodayOrTomorrow, resolveHomeWeek } from "./homeWeek";

const UNSERVED_STATUSES = new Set<MyRequestRow["status"]>(["waitlisted", "denied", "external", "proposed"]);

function reasonLine(row: MyRequestRow): string | null {
  // R7B1: only the Sadran's own typed reason, never the WhatsApp text.
  return (row.pendingProposal?.reasonHe || null) ?? describeStatusReason(row.statusReason);
}

/** The request/ride's own calendar day — same field priority as `requestStart` (an assigned
 * ride's actual start, falling back to the requested depart/return time). */
function rowDay(row: MyRequestRow): string | null {
  return row.ride?.startsAt ?? row.departAt ?? row.returnAt;
}

/**
 * `/my` — Home, "השבוע שלי" (UX_FLOWS.md §3.3) — the one member request/ride list (REQ §13
 * item 91, owner 2026-09-16, E3). Above the fold, spanning all weeks: next action (a proposal
 * awaiting my answer), my upcoming rides and my unserved requests with reason. Below: the week
 * chosen by `profiles.home_week_preference` and that week's requests, with the row actions
 * (edit / withdraw / cancel ride / make-repeating, each behind a confirmation, and edit / freed-
 * slot claim actions) that used to live on the separate `/requests` list. Only what lies ahead
 * shows here — a request/ride whose day has already passed is history, reachable only from the
 * "היסטוריה" link at the bottom (`/my/history`).
 */
export function HomePage() {
  const profileQuery = useProfile();
  const active = useActiveDepartment();
  // REQ §13.93: `departments.home_destination_id` per department, for `RequestRow`'s "מ<origin>
  // ל<destination>" display (`active.departments` already lists every active department).
  const homeDestinationIds = Object.fromEntries(active.departments.map((d) => [d.id, d.home_destination_id]));
  const requestsQuery = useMyRequests();
  const upcomingRidesQuery = useMyUpcomingRides();
  const rideTypesQuery = useRideTypes();
  const myCarsQuery = useMyResponsibleCarsQuery();
  const freedOffersQuery = useMyFreedSlotOffers();

  const defaultDepartmentId =
    active.departmentId;
  const weeksQuery = useWeeks(defaultDepartmentId);
  const carsQuery = useCars(defaultDepartmentId);
  const settingsQuery = useDepartmentSettings(defaultDepartmentId);
  // Owner 2026-10-16: list/table choice and the "children's rides" option are remembered on this device.
  const displayPrefs = useMyDisplayPrefs();
  const [searchParams, setSearchParams] = useSearchParams();
  // `?view=week|list` wins for this visit; otherwise the last choice made on this device (list by default).
  const weekView = (searchParams.get("view") ?? displayPrefs.view) === "week";
  const myChildrenQuery = useMyChildrenQuery(displayPrefs.showKidsRides);
  const myChildIds = new Set((myChildrenQuery.data ?? []).map((child) => child.id));
  const coGuardiansQuery = useMyCoGuardiansQuery(displayPrefs.showKidsRides);
  const guardianIds = new Set(coGuardiansQuery.data ?? []);
  // The rides query waits for the co-guardian lookup so it runs once with both id lists.
  const kidsRidesQuery = useMyChildrenRidesQuery([...myChildIds].sort(), displayPrefs.showKidsRides && !weekView && !coGuardiansQuery.isFetching, [...guardianIds].sort());
  const { tight: tightRideIds, mirrorNeighbours } = useTightRideIds(defaultDepartmentId, upcomingRidesQuery.data ?? [], weeksQuery.data ?? [], settingsQuery.data, homeDestinationIds[defaultDepartmentId ?? ""], carsQuery.data ?? []);

  // Show the immediate-car entry point for the current week even before its
  // Siddur has been published. In that case the same request is filed for the
  // coordinator rather than auto-approved; hiding the entry point entirely
  // made an available car look unavailable.
  const now = new Date();
  const [selectedMyRide, setSelectedMyRide] = useState<BoardRide | null>(null);
  const collapsedWeeks = useCollapsedWeeks();
  const [collisionMove, setCollisionMove] = useState<(RideMove & { departmentId: string; weekStart: string }) | null>(null);
  const [confirmAction, setConfirmAction] = useState<ConfirmAction | null>(null);
  const [shortenRow, setShortenRow] = useState<DisplayRow | null>(null);
  // "My rides" week view (owner 2026-10-11): a tapped request / suggestion block opens its own sheet; a ride block
  // reuses `selectedMyRide`, a proposal block navigates like `OpenProposalButton`.
  const [selectedRequestId, setSelectedRequestId] = useState<string | null>(null);
  const [selectedSuggestion, setSelectedSuggestion] = useState<TemplateSuggestion | null>(null);
  const openProposal = useOpenProposal();
  const cancelRideMutation = useCancelRideMutation();
  const removeMeMutation = useRemoveRidePassengerMutation();
  const editMutation = useEditRideMutation();
  const changeMutation = useRequestRideChangeMutation();
  const placeOnOwnCarMutation = usePlaceOnOwnCarMutation();
  const restoreDuplicateMutation = useRestoreDuplicateMutation();
  const ownCarsQuery = useMyTemporaryCars(profileQuery.data?.id);
  const ownCars = (ownCarsQuery.data ?? []).filter((car) => car.status === "active" && !car.retired_at).map((car) => ({ id: car.id, name: car.name }));
  const withdrawMutation = useWithdrawRequestMutation();
  const withdrawAllMutation = useWithdrawAllRequestsMutation();
  const claimMutation = useClaimFreedSlotMutation();
  const withdrawClaimMutation = useWithdrawFreedSlotClaimMutation();
  const optOutMutation = useSetFreedSlotOptOutMutation();
  const selectedRideWeekStart = selectedMyRide?.week_start ?? undefined;
  const selectedRideWeekQuery = useBoardRides(defaultDepartmentId, selectedRideWeekStart);
  const selectedRideChangesQuery = useRideChanges(defaultDepartmentId, selectedRideWeekStart);
  const sheetCarActions = useRideSheetCarActions({
    departmentId: selectedMyRide?.department_id ?? undefined,
    profileId: profileQuery.data?.id,
    myRequestIds: new Set((requestsQuery.data ?? []).map((request) => request.id)),
    week: (weeksQuery.data ?? []).find((week) => week.week_start === selectedMyRide?.week_start) ?? null,
    isMember: active.canSubmit,
    now,
  });

  // `?focus=<request_id>` (notification deep link, `notification_default_url`'s `/my?focus=<id>`
  // case, formerly `/requests?focus=`): scroll the matching card into view and ring-highlight it.
  const focusedId = searchParams.get("focus");
  const highlightedRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (focusedId) highlightedRef.current?.scrollIntoView({ behavior: "smooth", block: "center" });
  }, [focusedId]);

  // REQ §13.108 f: one fetch for the "be back on time" neighbours of every upcoming ride shown below
  // (the member's request rows and the upcoming-ride cards).
  const viewerId = profileQuery.data?.id;
  const handoverRideIds = [
    ...rowHandoverRideIds(toDisplayRows((requestsQuery.data ?? []).filter((row) => {
      const day = rowDay(row);
      return !day || isTodayOrLater(day, now);
    }))),
    ...(upcomingRidesQuery.data ?? []).flatMap((ride) => (ride.id ? [ride.id] : [])),
  ];
  const serverNeighbours = useCarNeighboursQuery(handoverRideIds).data;
  // Owner 2026-10-16: on a day the view hides (unpublished, managed by the viewer) the client mirror fills in.
  const neighboursByRide = serverNeighbours ? new Map(serverNeighbours) : undefined;
  if (neighboursByRide) {
    for (const id of new Set(handoverRideIds)) {
      if (neighboursByRide.has(id)) continue;
      const mirrored = mirrorNeighbours(id);
      if (mirrored) neighboursByRide.set(id, mirrored);
    }
  }

  const isLoading = active.isLoading || profileQuery.isLoading || requestsQuery.isLoading || upcomingRidesQuery.isLoading || weeksQuery.isLoading;

  if (isLoading) {
    return (
      <div className="mx-auto max-w-2xl space-y-4 p-4">
        <PageHeader title={t("screen.home.title")} />
        <CardListSkeleton count={2} />
        <CardListSkeleton count={2} />
      </div>
    );
  }

  // Only what lies ahead (REQ §13 item 91): a request/ride whose day has already passed never
  // shows on `/my`, in any of the sections below — it belongs to `/my/history` instead.
  const requests = (requestsQuery.data ?? [])
    .filter((row) => {
      const day = rowDay(row);
      return !day || isTodayOrLater(day, now);
    })
    .sort((a, b) => requestStart(a) - requestStart(b) || a.id.localeCompare(b.id));

  const upcomingRides = upcomingRidesQuery.data ?? [];

  function setView(next: "week" | "list") {
    displayPrefs.setView(next);
    // The picked view is remembered; a `?view=` of this visit must not override it any more.
    const params = new URLSearchParams(searchParams);
    params.delete("view");
    setSearchParams(params, { replace: true });
  }
  function openWeekTarget(target: MyWeekTarget) {
    if (target.type === "ride") setSelectedMyRide(target.ride);
    else if (target.type === "request") setSelectedRequestId(target.row.id);
    else if (target.type === "suggestion") setSelectedSuggestion(target.suggestion);
    else if (target.row.pendingProposal) void openProposal.open(target.row.pendingProposal.id);
  }

  const nextAction = requests.find((r) => r.status === "proposed" && r.pendingProposal && isAwaitingAnswer(r.pendingProposal));
  const unserved = requests.filter(
    // R10B5: a request served by its plan B is placed — never listed as unserved / waitlisted.
    (r) => !r.servedByAlternative && UNSERVED_STATUSES.has(displayStatus(r)) && r.id !== nextAction?.id,
  );

  // R7B8-1: "all placed" only when nothing is still waiting for the siddur; with neither unserved
  // requests nor that line, the section (and its heading) is not shown at all.
  const allPlaced = !requests.some((r) => r.status === "submitted" || r.status === "draft")
    && requests.some((r) => r.status === "assigned" || r.status === "merged");
  const weeks = (weeksQuery.data ?? []).map((w) => ({ weekStart: w.week_start, phase: w.phase }));
  const homeWeek = resolveHomeWeek(
    profileQuery.data?.home_week_preference ?? "auto",
    weeks,
    hasRideTodayOrTomorrow(
      upcomingRides.flatMap((ride) => ride.starts_at ? [ride.starts_at] : []),
      now,
    ),
  );
  // REQ §13.91: the ONE "my rides" list — every upcoming request, grouped by week (today
  // onward, already filtered above). `homeWeek` still decides which week the empty-state copy
  // and the new-request entry point talk about.
  // QB13: a request shown in the "unserved" section is not listed a second time below.
  const unservedIds = new Set(unserved.map((r) => r.id));
  // Owner 2026-10-13: one item per trip — a request carries the rides serving it; a ride none of my requests
  // reaches (I drive someone else's request, a reservation names me) is its own item in its week.
  // Owner 2026-10-16: read-only rides of my children (display option), muted and named, listed with mine.
  const myRequestIds = new Set((requestsQuery.data ?? []).map((request) => request.id));
  const relatedByRide = displayPrefs.showKidsRides && !weekView
    ? selectRelatedRides(kidsRidesQuery.data ?? [], { profileId: viewerId, childIds: myChildIds, guardianIds }, myRequestIds)
    : new Map<string, { kind: "child" | "guardian"; name: string }[]>();
  const relatedRides = (kidsRidesQuery.data ?? []).filter((ride) => !!ride.id && relatedByRide.has(ride.id) && !upcomingRides.some((mine) => mine.id === ride.id));
  const listedRides = [...upcomingRides, ...relatedRides];
  const rideRequestIds = (ride: BoardRide) => servedOf(ride).flatMap((entry) => (entry.request_id ? [entry.request_id] : []));
  const tripWeeks = buildTripWeeks(toDisplayRows(requests.filter((r) => !unservedIds.has(r.id))), unserved, listedRides, rideRequestIds);
  const unservedRides = ridesByRequestRow(unserved, upcomingRides, rideRequestIds);
  const rideCardOf = (ride: (typeof upcomingRides)[number]) => {
    const related = ride.id ? relatedByRide.get(ride.id) : undefined;
    return myRideCard(ride, requests, rideTypesQuery.data ?? [], {
      viewerId,
      neighbours: ride.id ? neighboursByRide?.get(ride.id) : undefined,
      tight: !!ride.id && tightRideIds.has(ride.id),
      relatedLabel: related?.length ? tv("myWeek.kidRideOf", { name: related.map((entry) => entry.name).join(", ") }) : undefined,
    });
  };
  const rideCardsOf = (rides: readonly (typeof upcomingRides)[number][] | undefined) =>
    (rides ?? []).flatMap((ride) => { const data = rideCardOf(ride); return data ? [data] : []; });
  const openRide = (rideId: string) => setSelectedMyRide(listedRides.find((ride) => ride.id === rideId) ?? null);
  // The display row (series folded) a tapped week-view request block stands for — the same row the list renders.
  const selectedWeekRow = selectedRequestId
    ? toDisplayRows(requests).find((row) => row.id === selectedRequestId || row.seriesLegs?.some((leg) => leg.id === selectedRequestId)) ?? null
    : null;
  const phaseOf = (weekStart: string) => weeks.find((w) => w.weekStart === weekStart)?.phase;
  const openOffers = (freedOffersQuery.data ?? []).filter(
    (o) => o.offerStatus === "open" && (o.claimStatus === "offered" || o.claimStatus === "claimed"),
  );
  // Fetch the selected ride's complete week before editing. The Home card is
  // intentionally small, but the same conflict and pending-change safeguards
  // as the Siddur must still apply.
  const editableRide = selectedMyRide?.id
    ? selectedRideWeekQuery.data?.find((ride) => ride.id === selectedMyRide.id) ?? null
    : null;
  const editableWeek = (weeksQuery.data ?? []).find((week) => week.week_start === editableRide?.week_start) ?? null;
  // REQ §13.127 (b): related = driver, a served request I made or filed, a named passenger, or the private car's owner.
  const editableRideCar = editableRide ? (carsQuery.data ?? []).find((car) => car.id === editableRide.car_id) : undefined;
  const editableRideRelated = !!editableRide && isRideRelated({
    ride: editableRide,
    profileId: profileQuery.data?.id,
    myRequestIds: new Set((requestsQuery.data ?? []).map((request) => request.id)),
    carOwnerId: editableRideCar?.type === "temporary" ? editableRideCar.owner_id : null,
  });
  const ownsEditableRide = !!editableRide &&
    // Same rule as `useMemberRideMoves`: a ride I drive keeping the car, or my own one-way (owner 2026-10-11).
    servedOf(editableRide).every((entry) => entry.role === "driver" && (entry.car_mode === "keep" || (entry.car_mode === "relay" && entry.trip_type === "one_way"))) &&
    active.canSubmit && editableRideRelated &&
    isRideDayEditable(editableRide.starts_at, now) &&
    (editableWeek?.phase === "published" || editableWeek?.phase === "live") &&
    !(selectedRideChangesQuery.data ?? []).some((change) => change.ride_id === editableRide.id);

  // Owner 2026-10-11 (parity with the siddur's `editHrefForRide`): my own editable request served by the opened ride.
  const selectedRideOwnRequest = selectedMyRide?.id
    ? (requestsQuery.data ?? []).find((request) => request.ride?.id === selectedMyRide.id && canEditRequest(request))
    : undefined;
  // Not one of my own requests but related to the ride: its driver's request (the edit page asks the server, REQ §13.127 b).
  const selectedRideCar = selectedMyRide ? (carsQuery.data ?? []).find((car) => car.id === selectedMyRide.car_id) : undefined;
  const selectedRideRelatedRequestId = selectedMyRide && !selectedRideOwnRequest
    && isRideRelated({
      ride: selectedMyRide,
      profileId: profileQuery.data?.id,
      myRequestIds: new Set((requestsQuery.data ?? []).map((request) => request.id)),
      carOwnerId: selectedRideCar?.type === "temporary" ? selectedRideCar.owner_id : null,
    })
    ? relatedRequestIdToEdit(selectedMyRide) : undefined;
  const selectedRideEditHref = selectedRideOwnRequest
    ? paths.requests.edit(selectedRideOwnRequest.id)
    : selectedRideRelatedRequestId ? paths.requests.edit(selectedRideRelatedRequestId) : undefined;
  // Same gate as the siddur's public-notes editor: my own (or an admin's) future ride on a published/live week.
  const selectedRidePhase = selectedMyRide?.week_start ? phaseOf(selectedMyRide.week_start) : undefined;
  const canEditSelectedRideNotes = !!selectedMyRide && selectedMyRide.status !== "cancelled"
    && isRideDayEditable(selectedMyRide.starts_at, now)
    && (selectedRidePhase === "published" || selectedRidePhase === "live")
    && (selectedMyRide.driver_id === profileQuery.data?.id || !!selectedRideEditHref || !!profileQuery.data?.is_admin);

  async function saveMyRideMove(move: RideMove) {
    if (!editableRide || !ownsEditableRide || !editableRide.department_id || !editableRide.week_start || !editableRide.origin_id || !editableRide.destination_id) return;
    if (conflictingRides(move, selectedRideWeekQuery.data ?? [], effectiveWeekSettings(settingsQuery.data, editableWeek).turnaroundMinutes).length) {
      setCollisionMove({ ...move, departmentId: editableRide.department_id, weekStart: editableRide.week_start });
      return;
    }
    try {
      await editMutation.mutateAsync({
        input: {
          id: move.rideId,
          department_id: editableRide.department_id,
          week_start: editableRide.week_start,
          car_id: move.carId,
          starts_at: move.startsAt,
          ends_at: move.endsAt,
          origin_id: editableRide.origin_id,
          destination_id: editableRide.destination_id,
          driver_id: editableRide.driver_id,
        },
        expectedVersion: move.expectedVersion,
        departmentId: editableRide.department_id,
        weekStart: editableRide.week_start,
      });
      setSelectedMyRide(null);
      toast.success(he.rideEditing.saved);
    } catch { /* The mutation presents the database validation error. */ }
  }

  async function runConfirmAction() {
    if (!confirmAction) return;
    try {
      if (confirmAction.kind === "withdrawAll") {
        await withdrawAllMutation.mutateAsync(confirmAction);
      } else if (confirmAction.kind === "withdraw") {
        await withdrawMutation.mutateAsync({ requestId: confirmAction.row.id, expectedVersion: confirmAction.row.version });
      } else if (confirmAction.kind === "withdrawFreedClaim") {
        await withdrawClaimMutation.mutateAsync({ offerId: confirmAction.offerId, requestId: confirmAction.requestId });
      } else if (confirmAction.row.ride) {
        await cancelRideMutation.mutateAsync({
          rideId: confirmAction.row.ride.id,
          reason: "CANCELLED_BY_MEMBER",
          expectedVersion: confirmAction.row.ride.version,
        });
      }
      setConfirmAction(null);
    } catch { /* Mutation shows a localized error; keep confirmation open for retry. */ }
  }

  return (
    <div className={cn("mx-auto space-y-6 p-4 pb-24", weekView ? "max-w-5xl lg:max-w-none" : "max-w-2xl")}>
      <PageHeader
        title={t("screen.home.title")}
        subtitle={
          profileQuery.data?.full_name
            ? tv("home.greeting", { name: profileQuery.data.full_name })
            : undefined
        }
        actions={weekView ? undefined : <MyWeekDisplayMenu view="list" onViewChange={setView} showKidsRides={displayPrefs.showKidsRides} onShowKidsRidesChange={displayPrefs.setShowKidsRides} />}
      />

      {!active.canSubmit && <p className="text-sm text-muted-foreground">{he.departmentContext.noMembership} <Link to={paths.siddur({ dept: active.departmentId })}>{he.nav.siddur}</Link></p>}

      {(myCarsQuery.data ?? []).length > 0 ? (
        <section className="space-y-2">
          <h2 className="text-sm font-semibold text-muted-foreground">{he.carPage.homeMyCarsTitle}</h2>
          <div className="space-y-2">
            {(myCarsQuery.data ?? []).map((car) => (
              <Link key={car.id} to={paths.car(car.id)}>
                <Card className="bg-gradient-card shadow-card transition-smooth hover:shadow-elegant">
                  <CardContent className="flex items-center justify-between gap-2 p-3 text-sm">
                    <div className="flex items-center gap-3">
                      <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
                        <CarFront className="size-5" aria-hidden="true" />
                      </span>
                      <div>
                        <p className="font-medium">{car.name}</p>
                        <p className="text-xs text-muted-foreground" dir="ltr">{car.license_plate}</p>
                      </div>
                    </div>
                    <StatusBadge kind="car" status={car.status} />
                  </CardContent>
                </Card>
              </Link>
            ))}
          </div>
        </section>
      ) : null}

      {/* Owner 2026-10-13: the week view needs no "רוצה רכב עכשיו!" — tapping "now" in the grid does the same. */}
      {active.canSubmit && defaultDepartmentId && !weekView ? <CarNowButton departmentId={defaultDepartmentId} /> : null}

      {nextAction?.pendingProposal ? (
        <OpenProposalButton
          proposalId={nextAction.pendingProposal.id}
          asChild
          variant="ghost"
          className="h-auto w-full justify-start rounded-md border-s-4 border-maintenance bg-maintenance/10 p-3 text-start text-sm font-normal text-inherit hover:bg-maintenance/10"
        >
          <div>
            <p className="font-medium text-maintenance">{t("home.nextAction")}</p>
            {reasonLine(nextAction) ? <p className="line-clamp-3 whitespace-normal break-words text-foreground/80">{reasonLine(nextAction)}</p> : null}
          </div>
        </OpenProposalButton>
      ) : null}

      {weekView ? (
        <MyWeekView
          departmentId={defaultDepartmentId}
          homeDestinationId={homeDestinationIds[defaultDepartmentId ?? ""]}
          profileId={viewerId}
          requests={requests}
          weeks={weeksQuery.data ?? []}
          homeWeekStart={homeWeek?.weekStart}
          canSubmit={active.canSubmit}
          onTarget={openWeekTarget}
          onViewChange={setView}
          showKidsRides={displayPrefs.showKidsRides}
          onShowKidsRidesChange={displayPrefs.setShowKidsRides}
          childIds={myChildIds}
          guardianIds={guardianIds}
        />
      ) : null}

      {!weekView ? <TemplateSuggestions /> : null}

      {/* R3U1: setup banners sit below the next action so they never push it off the first screen. */}
      <DeviceSetupPrompts />

      {!weekView && (unserved.length > 0 || allPlaced) ? <section className="space-y-3">
        <h2 className="text-sm font-semibold text-muted-foreground">{t("home.unservedRequests")}</h2>
        {unserved.length === 0 ? (
          <EmptyState icon={MessageCircleQuestion} message={t("home.emptyUnserved")} />
        ) : (
          <div className="space-y-2">
            {unserved.map((row) => (
              <RequestRow
                key={row.id}
                row={row}
                viewerId={viewerId}
                highlighted={row.id === focusedId}
                rowRef={row.id === focusedId ? highlightedRef : undefined}
                homeDestinationId={homeDestinationIds[row.departmentId]}
                rides={rideCardsOf(unservedRides.get(row.id))}
                onOpenRide={openRide}
                onWithdraw={(target) => setConfirmAction({ kind: "withdraw", row: target })}
                onCancelRide={(target) => setConfirmAction({ kind: "cancel", row: target })}
                onShorten={setShortenRow}
                onOptOutChange={(target, optOut) => optOutMutation.mutate({ requestId: target.id, optOut })}
                onPlaceOnOwnCar={(target, carId) =>
                  placeOnOwnCarMutation.mutate({ requestId: target.id, carId }, { onSuccess: () => toast.success(he.request.placedOnOwnCar) })
                }
                onRestoreDuplicate={(target) =>
                  restoreDuplicateMutation.mutate(target.id, { onSuccess: () => toast.success(he.request.notDuplicateRestored) })
                }
                ownCars={ownCars}
                actionPending={placeOnOwnCarMutation.isPending || restoreDuplicateMutation.isPending}
              />
            ))}
          </div>
        )}
      </section> : null}

      {openOffers.length > 0 ? (
        <section className="space-y-2">
          <h2 className="text-sm font-semibold text-muted-foreground">{he.freedSlot.title}</h2>
          {openOffers.map((offer) => (
            <div key={offer.offerId} className="space-y-2 rounded-md border border-maintenance/40 bg-maintenance/10 p-3 text-sm">
              <p>
                {tv("requestsList.freedSlotOffer", {
                  car: offer.carName,
                  day: "",
                  depart: formatTime(new Date(offer.startsAt)),
                  return: formatTime(new Date(offer.endsAt)),
                })}
              </p>
              {offer.claimStatus === "offered" ? (
                <Button size="sm" onClick={() => claimMutation.mutate({ offerId: offer.offerId, requestId: offer.requestId })}>
                  {t("action.stillWant")}
                </Button>
              ) : (
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => setConfirmAction({ kind: "withdrawFreedClaim", offerId: offer.offerId, requestId: offer.requestId })}
                >
                  {he.requestsList.withdrawClaim}
                </Button>
              )}
            </div>
          ))}
        </section>
      ) : null}

      {!weekView ? <section className="space-y-3 border-t pt-4">
        <h2 className="text-sm font-semibold text-muted-foreground">{t("home.myRides")}</h2>
        {upcomingRidesQuery.isError ? <ErrorState onRetry={() => void upcomingRidesQuery.refetch()} /> : null}
        {tripWeeks.length === 0 ? (
          <EmptyState
            icon={Inbox}
            message={
              !homeWeek || homeWeek.phase === "published" || homeWeek.phase === "live"
                ? t("home.emptyRequestsPublished")
                : tv("home.emptyRequestsOpen", {
                    weekLabel: formatWeekRangeLabel(homeWeek.weekStart),
                  })
            }
            action={active.canSubmit && <NewRequestButton variant="inline" />}
          />
        ) : (
          tripWeeks.map((group) => {
            const phase = phaseOf(group.weekStart);
            const weekKey = `${group.weekStart}:${group.departmentId}`;
            const collapsed = collapsedWeeks.isCollapsed(weekKey);
            return (
              <div key={weekKey} className="space-y-2" data-week-start={group.weekStart}>
                {/* Owner 2026-10-13: a week folds to its heading (remembered on this device). */}
                <button
                  type="button"
                  className="flex min-h-11 w-full items-center justify-between gap-2 rounded-md text-start"
                  aria-expanded={!collapsed}
                  onClick={() => collapsedWeeks.toggle(weekKey)}
                  data-testid="my-week-toggle"
                >
                  <span className="flex items-center gap-1 font-medium">
                    <ChevronDown className={cn("size-4 shrink-0 transition-transform", collapsed && "rotate-90")} aria-hidden="true" />
                    <span dir="ltr">{formatWeekRangeLabel(group.weekStart)}</span>
                    {collapsed ? <span className="text-sm font-normal text-muted-foreground">{tv("home.collapsedCount", { count: String(group.items.length) })}</span> : null}
                  </span>
                  {phase ? <span className="text-sm text-muted-foreground">{he.phase[phase]}</span> : null}
                </button>
                {collapsed ? null : <>
                {group.rows.some((row) => canEditRequest(row) && !isPublishedDayWindow(row.window)) ? (
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => setConfirmAction({ kind: "withdrawAll", departmentId: group.departmentId, weekStart: group.weekStart })}
                  >
                    {he.requestsList.withdrawAll}
                  </Button>
                ) : null}
                {group.items.map((item) => {
                  if (item.kind === "ride") {
                    const data = rideCardOf(item.ride);
                    return data ? <RideCard key={data.id} ride={data} onClick={() => setSelectedMyRide(item.ride)} /> : null;
                  }
                  const row = item.row;
                  return (
                    <RequestRow
                      key={row.id}
                      row={row}
                      viewerId={viewerId}
                      highlighted={row.id === focusedId}
                      rowRef={row.id === focusedId ? highlightedRef : undefined}
                      homeDestinationId={homeDestinationIds[group.departmentId]}
                      handover={rowHandover(row, neighboursByRide, viewerId)}
                      rides={rideCardsOf(item.rides)}
                      onOpenRide={openRide}
                      onWithdraw={(target) => setConfirmAction({ kind: "withdraw", row: target })}
                      onCancelRide={(target) => setConfirmAction({ kind: "cancel", row: target })}
                      onShorten={setShortenRow}
                      onOptOutChange={(target, optOut) => optOutMutation.mutate({ requestId: target.id, optOut })}
                      onPlaceOnOwnCar={(target, carId) =>
                        placeOnOwnCarMutation.mutate({ requestId: target.id, carId }, { onSuccess: () => toast.success(he.request.placedOnOwnCar) })
                      }
                      onRestoreDuplicate={(target) =>
                        restoreDuplicateMutation.mutate(target.id, { onSuccess: () => toast.success(he.request.notDuplicateRestored) })
                      }
                      ownCars={ownCars}
                      actionPending={placeOnOwnCarMutation.isPending || restoreDuplicateMutation.isPending}
                    />
                  );
                })}
                </>}
              </div>
            );
          })
        )}
      </section> : null}

      <div className="border-t pt-4 text-center">
        <Link to={paths.myHistory()} className="text-sm font-medium text-primary underline">
          {he.myHistory.link}
        </Link>
      </div>

      {active.canSubmit ? (
        <AddRideFab />
      ) : null}

      <RideDetailSheet
        {...sheetCarActions.sheetProps(selectedMyRide, () => setSelectedMyRide(null))}
        {...(editableRide && ownsEditableRide ? { moveToCarOptions: [] } : {})}
        ride={selectedMyRide}
        weekRides={selectedRideWeekQuery.data}
        car={selectedMyRide ? (carsQuery.data ?? []).find((car) => car.id === selectedMyRide.car_id) ?? null : null}
        locationBadge={null}
        onOpenChange={(open) => !open && setSelectedMyRide(null)}
        // "+ נוסעים" (REQ §13.85): `fetchMyUpcomingRides` only returns non-cancelled,
        // still-upcoming rides — in practice always in a published/live week (rides exist
        // once solved/published, before that only draft/manual-reservation pins do); the
        // RPC itself is the real gate (`week_archived`/`not_authorized` surface as toasts).
        showAddPassengers={!!selectedMyRide && selectedMyRide.status !== "cancelled" && isRideOfMine(selectedMyRide, viewerId, myRequestIds)}
        onRemoveOwnRide={selectedMyRide?.id && selectedMyRide.driver_id === profileQuery.data?.id && selectedMyRide.version != null ? () => cancelRideMutation.mutate({ rideId: selectedMyRide.id!, expectedVersion: selectedMyRide.version!, reason: "CANCELLED_BY_MEMBER" }, { onSuccess: () => setSelectedMyRide(null) }) : undefined}
        removingOwnRide={cancelRideMutation.isPending}
        onRemoveMe={(() => {
          const myKey = selectedMyRide ? myRidePersonKey(selectedMyRide, profileQuery.data?.id) : null;
          if (!selectedMyRide?.id || !myKey || selectedMyRide.version == null || !selectedMyRide.department_id || !selectedMyRide.week_start) return undefined;
          const { id, version, department_id, week_start } = selectedMyRide;
          return () => removeMeMutation.mutate({ rideId: id, expectedVersion: version, key: myKey, departmentId: department_id, weekStart: week_start }, { onSuccess: () => setSelectedMyRide(null) });
        })()}
        removingMe={removeMeMutation.isPending}
        // Owner 2026-10-11: the same "edit" button as on the siddur — opens my own request on this ride (day, stops, …).
        editRequestHref={selectedRideEditHref}
        canEditPublicNotes={canEditSelectedRideNotes}
        editor={editableRide && ownsEditableRide ? (
          <MemberRideEditor
            key={`${editableRide.id}:${editableRide.version}:editor`}
            ride={editableRide}
            cars={carsQuery.data ?? []}
            viewerId={profileQuery.data?.id}
            saving={editMutation.isPending || changeMutation.isPending}
            onSave={(move) => void saveMyRideMove(move)}
          />
        ) : undefined}
      />
      {/* "My rides" week view: a tapped request opens the same row (and actions) the list shows; a tapped suggestion the same three actions. */}
      <MyWeekItemSheet
        open={!!selectedWeekRow}
        title={he.myWeek.requestSheetTitle}
        onOpenChange={(open) => { if (!open) setSelectedRequestId(null); }}
      >
        {selectedWeekRow ? (
          <RequestRow
            row={selectedWeekRow}
            viewerId={viewerId}
            homeDestinationId={homeDestinationIds[selectedWeekRow.departmentId]}
            handover={rowHandover(selectedWeekRow, neighboursByRide, viewerId)}
            onWithdraw={(target) => { setSelectedRequestId(null); setConfirmAction({ kind: "withdraw", row: target }); }}
            onCancelRide={(target) => { setSelectedRequestId(null); setConfirmAction({ kind: "cancel", row: target }); }}
            onShorten={(target) => { setSelectedRequestId(null); setShortenRow(target); }}
            onOptOutChange={(target, optOut) => optOutMutation.mutate({ requestId: target.id, optOut })}
            onPlaceOnOwnCar={(target, carId) =>
              placeOnOwnCarMutation.mutate({ requestId: target.id, carId }, { onSuccess: () => toast.success(he.request.placedOnOwnCar) })
            }
            onRestoreDuplicate={(target) =>
              restoreDuplicateMutation.mutate(target.id, { onSuccess: () => toast.success(he.request.notDuplicateRestored) })
            }
            ownCars={ownCars}
            actionPending={placeOnOwnCarMutation.isPending || restoreDuplicateMutation.isPending}
          />
        ) : null}
      </MyWeekItemSheet>
      <MyWeekItemSheet
        open={!!selectedSuggestion}
        title={he.myWeek.suggestionSheetTitle}
        onOpenChange={(open) => { if (!open) setSelectedSuggestion(null); }}
      >
        {selectedSuggestion ? (
          <>
            <p className="text-sm text-muted-foreground">{he.myWeek.suggestionNote}</p>
            <TripSummary
              destination={selectedSuggestion.destinationName ?? selectedSuggestion.destinationText ?? ""}
              purpose={selectedSuggestion.rideTypeName ?? ""}
              departAt={selectedSuggestion.departAt}
              returnAt={selectedSuggestion.returnAt}
            />
            <TemplateSuggestionActions row={selectedSuggestion} onDone={() => setSelectedSuggestion(null)} />
          </>
        ) : null}
      </MyWeekItemSheet>
      <ShortenSeriesDialog row={shortenRow} onOpenChange={(open) => { if (!open) setShortenRow(null); }} />
      <ConfirmDialog
        open={!!collisionMove}
        onOpenChange={(open) => !open && setCollisionMove(null)}
        title={he.rideEditing.collisionTitle}
        description={he.rideEditing.collisionBody}
        confirmLabel={he.rideEditing.acknowledge}
        loading={changeMutation.isPending}
        onConfirm={() => {
          if (!collisionMove) return;
          changeMutation.mutate(collisionMove, { onSuccess: () => {
            setCollisionMove(null);
            setSelectedMyRide(null);
            toast.success(he.rideEditing.requested);
          } });
        }}
      />
      <ConfirmDialog
        open={!!confirmAction}
        onOpenChange={(open) => !open && setConfirmAction(null)}
        title={confirmDialogTitle(confirmAction)}
        description={confirmDialogDescription(confirmAction)}
        confirmLabel={confirmDialogLabel(confirmAction)}
        destructive
        loading={withdrawMutation.isPending || cancelRideMutation.isPending || withdrawAllMutation.isPending || withdrawClaimMutation.isPending}
        onConfirm={() => void runConfirmAction()}
      />
    </div>
  );
}
