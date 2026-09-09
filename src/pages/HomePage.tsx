import { useActiveDepartment } from "@/features/auth/useActiveDepartment";
import { CalendarClock, CarFront, Inbox, MessageCircleQuestion } from "lucide-react";
import { useState } from "react";
import { Link } from "react-router-dom";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { EmptyState } from "@/components/EmptyState";
import { ErrorState } from "@/components/ErrorState";
import { PageHeader } from "@/components/PageHeader";
import { datesOfWeek } from "@/components/DateField";
import { RideCard } from "@/components/RideCard";
import { CardListSkeleton } from "@/components/skeletons/CardListSkeleton";
import { StatusBadge } from "@/components/StatusBadge";
import { formatWeekRangeLabel, todayInJerusalem } from "@/components/DateField";
import { useProfile } from "@/features/auth/useProfile";
import { DeviceSetupPrompts } from "@/features/member/components/DeviceSetupPrompts";
import { useMyResponsibleCarsQuery } from "@/features/cars/hooks";
import { useCars, useRideTypes } from "@/features/fleet/hooks";
import { AddRideFab } from "@/features/requests/components/AddRideFab";
import { QuickRequestSheet } from "@/features/requests/components/QuickRequestSheet";
import { useMyRequests, useCancelRideMutation } from "@/features/requests/hooks";
import type { MyRequestRow } from "@/features/requests/api";
import { firstCarFreeNow, roundUpToQuarterHour } from "@/features/siddur/freeWindows";
import { useBoardRides, useRideChanges, useWeeks, useMyUpcomingRides, useRequestRideChangeMutation } from "@/features/siddur/hooks";
import { RideDetailSheet } from "@/features/siddur/components/RideDetailSheet";
import { MemberRideEditor } from "@/features/siddur/components/MemberRideEditor";
import type { BoardRide, RideMove } from "@/features/siddur/api";
import { myRideCard } from "@/features/siddur/myRideCard";
import { conflictingRides } from "@/features/siddur/rideEditing";
import { TripSummary } from "@/components/TripSummary";
import { useDayFreeWindows } from "@/features/siddur/useDayFreeWindows";
import { useDepartmentSettings, useEditRideMutation } from "@/features/sadran/hooks";
import { servedOf } from "@/features/sadran/solverRun";
import { he, t, tv } from "@/i18n/he";
import { describeStatusReason } from "@/lib/statusReason";
import { formatTime } from "@/lib/time";
import { paths } from "@/app/routes";

import { hasRideTodayOrTomorrow, resolveHomeWeek } from "./homeWeek";

const UNSERVED_STATUSES = new Set<MyRequestRow["status"]>(["waitlisted", "denied", "proposed"]);

function reasonLine(row: MyRequestRow): string | null {
  if (row.pendingProposal) return row.pendingProposal.reasonHe;
  return describeStatusReason(row.statusReason);
}

/**
 * `/my` — Home, "השבוע שלי" (UX_FLOWS.md §3.3). Above the fold, spanning all
 * weeks: next action (a proposal awaiting my answer), my upcoming rides and
 * my unserved requests with reason. Below: the week chosen by
 * `profiles.home_week_preference` and that week's requests.
 */
export function HomePage() {
  const profileQuery = useProfile();
  const active = useActiveDepartment();
  const requestsQuery = useMyRequests();
  const upcomingRidesQuery = useMyUpcomingRides();
  const rideTypesQuery = useRideTypes();
  const myCarsQuery = useMyResponsibleCarsQuery();

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
  const today = todayInJerusalem();
  const currentWeek = (weeksQuery.data ?? []).find((w) => datesOfWeek(w.week_start).includes(today));
  const currentWeekStart = currentWeek?.week_start;
  const dayFreeWindows = useDayFreeWindows(defaultDepartmentId, currentWeekStart, currentWeekStart ? today : undefined, now);
  const freeCarNow = firstCarFreeNow(dayFreeWindows.freeWindows, now.getTime());
  const quickCarId = freeCarNow?.carId ?? dayFreeWindows.cars[0]?.id;
  const [quickRequestOpen, setQuickRequestOpen] = useState(false);
  const [selectedMyRide, setSelectedMyRide] = useState<BoardRide | null>(null);
  const [collisionMove, setCollisionMove] = useState<RideMove | null>(null);
  const cancelRideMutation = useCancelRideMutation();
  const editMutation = useEditRideMutation();
  const changeMutation = useRequestRideChangeMutation();
  const selectedRideWeekStart = selectedMyRide?.week_start ?? undefined;
  const selectedRideWeekQuery = useBoardRides(defaultDepartmentId, selectedRideWeekStart);
  const selectedRideChangesQuery = useRideChanges(defaultDepartmentId, selectedRideWeekStart);

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

  const requests = [...(requestsQuery.data ?? [])].sort((a, b) => {
    const start = (row: MyRequestRow) => {
      const instant = row.ride?.startsAt ?? row.departAt ?? row.returnAt;
      return instant ? Date.parse(instant) : Infinity;
    };
    return start(a) - start(b) || a.id.localeCompare(b.id);
  });

  const upcomingRides = upcomingRidesQuery.data ?? [];

  const nextAction = requests.find((r) => r.status === "proposed" && r.pendingProposal);
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
  const weekRequests = homeWeek ? requests.filter((r) => r.weekStart === homeWeek.weekStart) : [];
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
      setCollisionMove(move);
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

      {active.canSubmit && currentWeekStart ? (
        <Card
          role={freeCarNow ? "button" : undefined}
          tabIndex={freeCarNow ? 0 : undefined}
          className={freeCarNow ? "cursor-pointer bg-gradient-card shadow-card transition-smooth hover:shadow-elegant" : "bg-muted/50 shadow-card"}
          onClick={() => freeCarNow && setQuickRequestOpen(true)}
        >
          <CardContent className="flex items-center justify-between gap-2 p-4 text-sm">
            <div className="flex items-center gap-3">
              <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-available/10 text-available">
                <CarFront className="size-5" aria-hidden="true" />
              </span>
              <div>
                <p className="font-medium">{freeCarNow ? t("quickRequest.takeCarNow") : t("quickRequest.noCarNow")}</p>
                {freeCarNow ? <p className="text-xs text-muted-foreground">{tv("quickRequest.homeCardSubtitle", { car: dayFreeWindows.cars.find((c) => c.id === freeCarNow.carId)?.name ?? "" })}</p> : null}
              </div>
            </div>
          </CardContent>
        </Card>
      ) : null}

      {nextAction ? (
        <div className="rounded-md border-s-4 border-maintenance bg-maintenance/10 p-3 text-sm">
          <p className="font-medium text-maintenance">{t("home.nextAction")}</p>
          <p className="text-foreground/80">{reasonLine(nextAction)}</p>
        </div>
      ) : null}

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
              <Card key={row.id} className="bg-gradient-card shadow-card">
                <CardContent className="space-y-1 p-3 text-sm">
                  <div className="flex items-center justify-between gap-2">
                    <span className="font-medium">{row.destination}</span>
                    <StatusBadge kind="request" status={row.status} />
                  </div>
                  <TripSummary purpose={row.rideTypeName} departAt={row.ride?.startsAt ?? row.departAt} returnAt={row.ride?.endsAt ?? row.returnAt} />
                  {reasonLine(row) ? (
                    <p className="text-xs text-muted-foreground">{reasonLine(row)}</p>
                  ) : null}
                </CardContent>
              </Card>
            ))}
          </div>
        )}
      </section>

      {homeWeek ? (
        <section className="space-y-3 border-t pt-4">
          <div className="flex items-center justify-between">
            <span className="font-medium" dir="ltr">
              {formatWeekRangeLabel(homeWeek.weekStart)}
            </span>
            <span className="text-sm text-muted-foreground">{he.phase[homeWeek.phase]}</span>
          </div>
          <p className="text-sm text-muted-foreground">{t("home.weekRequests")}</p>
          {weekRequests.length === 0 ? (
            <EmptyState
              icon={Inbox}
              message={
                homeWeek.phase === "published" || homeWeek.phase === "live"
                  ? t("home.emptyRequestsPublished")
                  : tv("home.emptyRequestsOpen", {
                      weekLabel: formatWeekRangeLabel(homeWeek.weekStart),
                    })
              }
              action={active.canSubmit &&
                <Button asChild size="sm">
                  <Link to={paths.requests.new()}>{t("action.newRequest")}</Link>
                </Button>
              }
            />
          ) : (
            <div className="space-y-2">
              {weekRequests.map((row) => (
                <Card key={row.id} className="bg-gradient-card shadow-card">
                  <CardContent className="flex items-center justify-between gap-2 p-3 text-sm">
                    <TripSummary destination={row.destination} purpose={row.rideTypeName} departAt={row.ride?.startsAt ?? row.departAt} returnAt={row.ride?.endsAt ?? row.returnAt} />
                    <StatusBadge kind="request" status={row.status} />
                  </CardContent>
                </Card>
              ))}
            </div>
          )}
        </section>
      ) : null}

      {active.canSubmit ? (
        <AddRideFab
          isLiveWeek={currentWeek?.phase === "live" && !!quickCarId}
          onQuickRequest={() => setQuickRequestOpen(true)}
        />
      ) : null}

      {quickRequestOpen && quickCarId && defaultDepartmentId && currentWeekStart ? (
        <QuickRequestSheet
          open={quickRequestOpen}
          onOpenChange={setQuickRequestOpen}
          departmentId={defaultDepartmentId}
          weekStart={currentWeekStart}
          day={today}
          initialStartTime={formatTime(new Date(roundUpToQuarterHour(now.getTime())))}
          initialCarId={quickCarId}
          showCarPicker
          cars={dayFreeWindows.cars}
          freeWindows={dayFreeWindows.freeWindows}
          awayWindows={dayFreeWindows.awayWindows}
          now={now}
        />
      ) : null}
      <RideDetailSheet
        ride={selectedMyRide}
        car={selectedMyRide ? (carsQuery.data ?? []).find((car) => car.id === selectedMyRide.car_id) ?? null : null}
        locationBadge={null}
        onOpenChange={(open) => !open && setSelectedMyRide(null)}
        onAskToJoin={() => undefined}
        showAskToJoin={false}
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
    </div>
  );
}
