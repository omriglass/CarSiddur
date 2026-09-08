import { useActiveDepartment } from "@/features/auth/useActiveDepartment";
import { CalendarClock, CarFront, Inbox, MessageCircleQuestion } from "lucide-react";
import { useState } from "react";
import { Link } from "react-router-dom";
import { formatInTimeZone } from "date-fns-tz";

import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
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
import { useDestinations, useRideTypes } from "@/features/fleet/hooks";
import { QuickRequestSheet } from "@/features/requests/components/QuickRequestSheet";
import { useMyRequests } from "@/features/requests/hooks";
import type { MyRequestRow } from "@/features/requests/api";
import { firstCarFreeNow, roundUpToQuarterHour } from "@/features/siddur/freeWindows";
import { useWeeks, useMyUpcomingRides } from "@/features/siddur/hooks";
import { myRideCard } from "@/features/siddur/myRideCard";
import { TripSummary } from "@/components/TripSummary";
import { useDayFreeWindows } from "@/features/siddur/useDayFreeWindows";
import { he, t, tv } from "@/i18n/he";
import { TZ } from "@/lib/time";

import { hasRideTodayOrTomorrow, resolveHomeWeek } from "./homeWeek";

const UNSERVED_STATUSES = new Set<MyRequestRow["status"]>(["waitlisted", "denied", "proposed"]);

function reasonLine(row: MyRequestRow): string | null {
  if (row.pendingProposal) return row.pendingProposal.reasonHe;
  if (row.statusReason && row.statusReason in he.statusReason) {
    return he.statusReason[row.statusReason as keyof typeof he.statusReason];
  }
  return row.statusReason;
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
  const destinationsQuery = useDestinations();
  const rideTypesQuery = useRideTypes();

  const defaultDepartmentId =
    active.departmentId;
  const weeksQuery = useWeeks(defaultDepartmentId);

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
  const [quickRequestOpen, setQuickRequestOpen] = useState(false);
  const defaultRideTypeId = rideTypesQuery.data?.find((rt) => rt.code === "other")?.id ?? rideTypesQuery.data?.[0]?.id ?? "";

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
      {!active.canSubmit && <p className="text-sm text-muted-foreground">{he.departmentContext.noMembership} <Link to={`/siddur/${active.departmentId}`}>{he.nav.siddur}</Link></p>}

      {active.canSubmit && freeCarNow ? (
        <Card
          role="button"
          tabIndex={0}
          className="cursor-pointer bg-gradient-card shadow-card transition-smooth hover:shadow-elegant"
          onClick={() => setQuickRequestOpen(true)}
        >
          <CardContent className="flex items-center justify-between gap-2 p-4 text-sm">
            <div className="flex items-center gap-3">
              <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-available/10 text-available">
                <CarFront className="size-5" aria-hidden="true" />
              </span>
              <div>
                <p className="font-medium">{t("quickRequest.takeCarNow")}</p>
                <p className="text-xs text-muted-foreground">
                  {tv("quickRequest.homeCardSubtitle", {
                    car: dayFreeWindows.cars.find((c) => c.id === freeCarNow.carId)?.name ?? "",
                  })}
                </p>
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
              return data ? <RideCard key={row.id} ride={data} /> : null;
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
                  <Link to="/requests/new">{t("action.newRequest")}</Link>
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

      {active.canSubmit && <Button asChild size="lg" className="fixed bottom-20 end-4 z-30 rounded-full shadow-lg md:bottom-6">
        <Link to="/requests/new">{t("action.newRequest")}</Link>
      </Button>}

      {quickRequestOpen && freeCarNow && defaultDepartmentId && currentWeekStart ? (
        <QuickRequestSheet
          open={quickRequestOpen}
          onOpenChange={setQuickRequestOpen}
          departmentId={defaultDepartmentId}
          weekStart={currentWeekStart}
          rideTypeId={defaultRideTypeId}
          day={today}
          initialStartTime={formatInTimeZone(new Date(roundUpToQuarterHour(now.getTime())), TZ, "HH:mm")}
          initialCarId={freeCarNow.carId}
          showCarPicker
          cars={dayFreeWindows.cars}
          destinations={(destinationsQuery.data ?? []).map((d) => ({
            id: d.id,
            name: d.name,
            aliases: d.aliases,
            zone: d.zone,
          }))}
          freeWindows={dayFreeWindows.freeWindows}
          awayWindows={dayFreeWindows.awayWindows}
          now={now}
        />
      ) : null}
    </div>
  );
}
