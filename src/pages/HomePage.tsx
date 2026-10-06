import { useActiveDepartment } from "@/features/auth/useActiveDepartment";
import { CalendarClock, Inbox, MessageCircleQuestion, CarFront } from "lucide-react";
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
import { useCars, useMyTemporaryCars, useRideTypes } from "@/features/fleet/hooks";
import { AddRideFab } from "@/features/requests/components/AddRideFab";
import { CarNowButton } from "@/features/requests/components/CarNowButton";
import { NewRequestButton } from "@/features/requests/components/NewRequestButton";
import { RequestRow } from "@/features/requests/components/RequestRow";
import { TemplateSuggestions } from "@/features/requests/components/TemplateSuggestions";
import {
  useCancelRideMutation,
  usePlaceOnOwnCarMutation,
  useRestoreDuplicateMutation,
  useClaimFreedSlotMutation,
  useMyFreedSlotOffers,
  useMyRequests,
  useSaveRequestTemplateMutation,
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
  groupByWeek,
  requestStart,
  toDisplayRows,
  type ConfirmAction,
} from "@/features/requests/myRequestsRows";
import { isTodayOrLater } from "@/features/requests/upcoming";
import { useBoardRides, useWeeks, useMyUpcomingRides } from "@/features/siddur/hooks";
import { useRideChanges, useRequestRideChangeMutation } from "@/features/rides/hooks";
import { RideDetailSheet } from "@/features/siddur/components/RideDetailSheet";
import { MemberRideEditor } from "@/features/siddur/components/MemberRideEditor";
import type { BoardRide } from "@/features/siddur/api";
import type { RideMove } from "@/features/rides/api";
import { myRideCard } from "@/features/siddur/myRideCard";
import { conflictingRides } from "@/features/siddur/rideEditing";
import { useDepartmentSettings, useEditRideMutation } from "@/features/sadran/hooks";
import { servedOf } from "@/features/rides/servedOf";
import { OpenProposalButton } from "@/features/proposals/components/OpenProposalButton";
import { he, t, tv } from "@/i18n/he";
import { describeStatusReason } from "@/lib/statusReason";
import { formatTime } from "@/lib/time";
import { paths } from "@/app/routes";

import { isAwaitingAnswer } from "@/features/requests/pendingProposal";
import { hasRideTodayOrTomorrow, resolveHomeWeek } from "./homeWeek";

const UNSERVED_STATUSES = new Set<MyRequestRow["status"]>(["waitlisted", "denied", "external", "proposed"]);

function reasonLine(row: MyRequestRow): string | null {
  if (row.pendingProposal) return row.pendingProposal.reasonHe;
  return describeStatusReason(row.statusReason);
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

  // Show the immediate-car entry point for the current week even before its
  // Siddur has been published. In that case the same request is filed for the
  // coordinator rather than auto-approved; hiding the entry point entirely
  // made an available car look unavailable.
  const now = new Date();
  const [selectedMyRide, setSelectedMyRide] = useState<BoardRide | null>(null);
  const [collisionMove, setCollisionMove] = useState<(RideMove & { departmentId: string; weekStart: string }) | null>(null);
  const [confirmAction, setConfirmAction] = useState<ConfirmAction | null>(null);
  const cancelRideMutation = useCancelRideMutation();
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
  const saveTemplateMutation = useSaveRequestTemplateMutation();
  const selectedRideWeekStart = selectedMyRide?.week_start ?? undefined;
  const selectedRideWeekQuery = useBoardRides(defaultDepartmentId, selectedRideWeekStart);
  const selectedRideChangesQuery = useRideChanges(defaultDepartmentId, selectedRideWeekStart);

  // `?focus=<request_id>` (notification deep link, `notification_default_url`'s `/my?focus=<id>`
  // case, formerly `/requests?focus=`): scroll the matching card into view and ring-highlight it.
  const [searchParams] = useSearchParams();
  const focusedId = searchParams.get("focus");
  const highlightedRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (focusedId) highlightedRef.current?.scrollIntoView({ behavior: "smooth", block: "center" });
  }, [focusedId]);

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

  const nextAction = requests.find((r) => r.status === "proposed" && r.pendingProposal && isAwaitingAnswer(r.pendingProposal));
  const unserved = requests.filter(
    (r) => UNSERVED_STATUSES.has(r.status) && r.id !== nextAction?.id,
  );

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
  const upcomingWeeks = groupByWeek(toDisplayRows(requests.filter((r) => !unservedIds.has(r.id)))).sort((a, b) => a.weekStart.localeCompare(b.weekStart));
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
  const ownsEditableRide = !!editableRide &&
    servedOf(editableRide).every((entry) => entry.role === "driver" && entry.car_mode === "keep") &&
    active.canSubmit && editableRide.driver_id === profileQuery.data?.id &&
    !!editableRide.starts_at && Date.parse(editableRide.starts_at) > now.getTime() &&
    (editableWeek?.phase === "published" || editableWeek?.phase === "live") &&
    !(selectedRideChangesQuery.data ?? []).some((change) => change.ride_id === editableRide.id);

  async function saveMyRideMove(move: RideMove) {
    if (!editableRide || !ownsEditableRide || !editableRide.department_id || !editableRide.week_start || !editableRide.origin_id || !editableRide.destination_id) return;
    if (conflictingRides(move, selectedRideWeekQuery.data ?? [], settingsQuery.data?.turnaround_minutes ?? 30).length) {
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
    <div className="mx-auto max-w-2xl space-y-6 p-4 pb-24">
      <PageHeader
        title={t("screen.home.title")}
        subtitle={
          profileQuery.data?.full_name
            ? tv("home.greeting", { name: profileQuery.data.full_name })
            : undefined
        }
      />

      <DeviceSetupPrompts />
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

      {active.canSubmit && defaultDepartmentId ? <CarNowButton departmentId={defaultDepartmentId} /> : null}

      {nextAction?.pendingProposal ? (
        <OpenProposalButton
          proposalId={nextAction.pendingProposal.id}
          asChild
          variant="ghost"
          className="h-auto w-full justify-start rounded-md border-s-4 border-maintenance bg-maintenance/10 p-3 text-start text-sm font-normal text-inherit hover:bg-maintenance/10"
        >
          <div>
            <p className="font-medium text-maintenance">{t("home.nextAction")}</p>
            <p className="line-clamp-3 whitespace-normal break-words text-foreground/80">{reasonLine(nextAction)}</p>
          </div>
        </OpenProposalButton>
      ) : null}

      <TemplateSuggestions />

      <section className="space-y-3">
        <h2 className="text-sm font-semibold text-muted-foreground">{t("home.upcomingRides")}</h2>
        {upcomingRidesQuery.isError ? (
          <ErrorState onRetry={() => void upcomingRidesQuery.refetch()} />
        ) : upcomingRides.length === 0 ? (
          <EmptyState icon={CalendarClock} message={t("home.emptyUpcoming")} />
        ) : (
          <div className="space-y-2">
            {upcomingRides.map((row) => {
              const data = myRideCard(row, requests, rideTypesQuery.data ?? []);
              return data ? <RideCard key={row.id} ride={data} onClick={() => setSelectedMyRide(row)} /> : null;
            })}
          </div>
        )}
      </section>

      <section className="space-y-3">
        <h2 className="text-sm font-semibold text-muted-foreground">{t("home.unservedRequests")}</h2>
        {unserved.length === 0 ? (
          <EmptyState icon={MessageCircleQuestion} message={t("home.emptyUnserved")} />
        ) : (
          <div className="space-y-2">
            {unserved.map((row) => (
              <RequestRow
                key={row.id}
                row={row}
                highlighted={row.id === focusedId}
                rowRef={row.id === focusedId ? highlightedRef : undefined}
                homeDestinationId={homeDestinationIds[row.departmentId]}
                onWithdraw={(target) => setConfirmAction({ kind: "withdraw", row: target })}
                onCancelRide={(target) => setConfirmAction({ kind: "cancel", row: target })}
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
      </section>

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

      <section className="space-y-3 border-t pt-4">
        <p className="text-sm text-muted-foreground">{t("home.weekRequests")}</p>
        {requests.length === 0 ? (
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
          upcomingWeeks.map((group) => {
            const phase = phaseOf(group.weekStart);
            return (
              <div key={`${group.weekStart}:${group.departmentId}`} className="space-y-2" data-week-start={group.weekStart}>
                <div className="flex items-center justify-between">
                  <span className="font-medium" dir="ltr">
                    {formatWeekRangeLabel(group.weekStart)}
                  </span>
                  {phase ? <span className="text-sm text-muted-foreground">{he.phase[phase]}</span> : null}
                </div>
                {group.rows.some((row) => canEditRequest(row) && !isPublishedDayWindow(row.window)) ? (
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => setConfirmAction({ kind: "withdrawAll", departmentId: group.departmentId, weekStart: group.weekStart })}
                  >
                    {he.requestsList.withdrawAll}
                  </Button>
                ) : null}
                {group.rows.map((row) => (
                  <RequestRow
                    key={row.id}
                    row={row}
                    highlighted={row.id === focusedId}
                    rowRef={row.id === focusedId ? highlightedRef : undefined}
                    homeDestinationId={homeDestinationIds[group.departmentId]}
                    onWithdraw={(target) => setConfirmAction({ kind: "withdraw", row: target })}
                    onCancelRide={(target) => setConfirmAction({ kind: "cancel", row: target })}
                    onMakeRepeating={(target) =>
                      saveTemplateMutation.mutate(target.id, { onSuccess: () => toast.success(he.request.repeatSaved) })
                    }
                    makeRepeatingPending={saveTemplateMutation.isPending}
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
            );
          })
        )}
      </section>

      <div className="border-t pt-4 text-center">
        <Link to={paths.myHistory()} className="text-sm font-medium text-primary underline">
          {he.myHistory.link}
        </Link>
      </div>

      {active.canSubmit ? (
        <AddRideFab />
      ) : null}

      <RideDetailSheet
        ride={selectedMyRide}
        weekRides={selectedRideWeekQuery.data}
        car={selectedMyRide ? (carsQuery.data ?? []).find((car) => car.id === selectedMyRide.car_id) ?? null : null}
        locationBadge={null}
        onOpenChange={(open) => !open && setSelectedMyRide(null)}
        // "+ נוסעים" (REQ §13.85): `fetchMyUpcomingRides` only returns non-cancelled,
        // still-upcoming rides — in practice always in a published/live week (rides exist
        // once solved/published, before that only draft/manual-reservation pins do); the
        // RPC itself is the real gate (`week_archived`/`not_authorized` surface as toasts).
        showAddPassengers={!!selectedMyRide && selectedMyRide.status !== "cancelled"}
        onRemoveOwnRide={selectedMyRide?.id && selectedMyRide.version != null ? () => cancelRideMutation.mutate({ rideId: selectedMyRide.id!, expectedVersion: selectedMyRide.version!, reason: "CANCELLED_BY_MEMBER" }, { onSuccess: () => setSelectedMyRide(null) }) : undefined}
        removingOwnRide={cancelRideMutation.isPending}
        editor={editableRide && ownsEditableRide ? (
          <MemberRideEditor
            key={`${editableRide.id}:${editableRide.version}`}
            ride={editableRide}
            cars={carsQuery.data ?? []}
            saving={editMutation.isPending || changeMutation.isPending}
            onSave={(move) => void saveMyRideMove(move)}
          />
        ) : undefined}
      />
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
