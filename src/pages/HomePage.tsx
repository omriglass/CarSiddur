import { CalendarClock, CarFront, Inbox, MessageCircleQuestion } from "lucide-react";
import { useState } from "react";
import { Link } from "react-router-dom";
import { formatInTimeZone } from "date-fns-tz";

import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { EmptyState } from "@/components/EmptyState";
import { PageHeader } from "@/components/PageHeader";
import { RideCard, type RideCardData } from "@/components/RideCard";
import { StatusBadge } from "@/components/StatusBadge";
import { formatWeekRangeLabel, todayInJerusalem } from "@/components/DateField";
import { useMyDepartments } from "@/features/auth/useMyDepartments";
import { useProfile } from "@/features/auth/useProfile";
import { useDestinations, useRideTypes } from "@/features/fleet/hooks";
import { QuickRequestSheet } from "@/features/requests/components/QuickRequestSheet";
import { useMyRequests } from "@/features/requests/hooks";
import type { MyRequestRow } from "@/features/requests/api";
import { firstCarFreeNow, roundUpToQuarterHour } from "@/features/siddur/freeWindows";
import { useWeeks } from "@/features/siddur/hooks";
import { useDayFreeWindows } from "@/features/siddur/useDayFreeWindows";
import { he, t, tv } from "@/i18n/he";
import { formatTime, TZ } from "@/lib/time";

import { hasRideTodayOrTomorrow, resolveHomeWeek } from "./homeWeek";

const UNSERVED_STATUSES = new Set<MyRequestRow["status"]>(["waitlisted", "denied", "proposed"]);

/**
 * Owner-reported bug (UX_FLOWS.md §20): a round trip is stored as one ride
 * row with `origin_id === destination_id === the department's home
 * location` (DATA_MODEL.md consistency decision #14), so `row.ride.
 * destinationName` is always the department's own name ("נבו") for that
 * common case — `row.destination` (the *request's* own destination, always
 * the real place regardless of how the ride row happens to store it) is
 * used instead. One-way requests are unaffected: their ride row's own
 * `destinationName` is already the real place (one-way-to) or genuinely home
 * (one-way-from), so this only overrides the round-trip case — matching the
 * same underlying fix already shipped for the Sadran board's phone list mode
 * (`rideBlockLabel`/`resolveRideRealDestination`, `src/lib/rideLabel.ts`).
 */
function toRideCardData(row: MyRequestRow): RideCardData | null {
  if (!row.ride) return null;
  return {
    id: row.ride.id,
    startsAt: row.ride.startsAt,
    endsAt: row.ride.endsAt,
    originName: row.ride.originName,
    destinationName: row.tripShape === "round_trip" ? row.destination : row.ride.destinationName,
    driverName: row.ride.driverName,
    isChauffeur: row.ride.isChauffeur,
    carName: row.ride.carName,
    carType: row.ride.carType ?? undefined,
  };
}

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
  const departmentsQuery = useMyDepartments();
  const requestsQuery = useMyRequests();
  const destinationsQuery = useDestinations();
  const rideTypesQuery = useRideTypes();

  const defaultDepartmentId =
    profileQuery.data?.default_department_id ?? departmentsQuery.data?.[0]?.department_id;
  const weeksQuery = useWeeks(defaultDepartmentId);

  // "לוקח/ת רכב עכשיו" card (UX_FLOWS.md §18): only when the live week exists and some shared
  // car is free right now. Hooks must run unconditionally (before the loading early-return
  // below), so `now`/the live week start are resolved here even while other data is loading.
  const now = new Date();
  const today = todayInJerusalem();
  const liveWeekStart = (weeksQuery.data ?? []).find((w) => w.phase === "live")?.week_start;
  const dayFreeWindows = useDayFreeWindows(defaultDepartmentId, liveWeekStart, liveWeekStart ? today : undefined, now);
  const freeCarNow = firstCarFreeNow(dayFreeWindows.freeWindows, now.getTime());
  const [quickRequestOpen, setQuickRequestOpen] = useState(false);
  const defaultRideTypeId = rideTypesQuery.data?.find((rt) => rt.code === "other")?.id ?? rideTypesQuery.data?.[0]?.id ?? "";

  const isLoading = profileQuery.isLoading || requestsQuery.isLoading || weeksQuery.isLoading;

  if (isLoading) {
    return (
      <div className="mx-auto max-w-2xl space-y-4 p-4">
        <PageHeader title={t("screen.home.title")} />
        <div className="h-24 animate-pulse rounded-md bg-muted" />
        <div className="h-24 animate-pulse rounded-md bg-muted" />
      </div>
    );
  }

  const requests = requestsQuery.data ?? [];

  const upcomingRides = requests
    .filter((r) => r.ride && r.ride.status !== "cancelled" && new Date(r.ride.startsAt) >= now)
    .sort((a, b) => new Date(a.ride!.startsAt).getTime() - new Date(b.ride!.startsAt).getTime());

  const nextAction = requests.find((r) => r.status === "proposed" && r.pendingProposal);
  const unserved = requests.filter(
    (r) => UNSERVED_STATUSES.has(r.status) && r.id !== nextAction?.id,
  );

  const weeks = (weeksQuery.data ?? []).map((w) => ({ weekStart: w.week_start, phase: w.phase }));
  const homeWeek = resolveHomeWeek(
    profileQuery.data?.home_week_preference ?? "auto",
    weeks,
    hasRideTodayOrTomorrow(
      upcomingRides.map((r) => r.ride!.startsAt),
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

      {nextAction ? (
        <div className="rounded-md border-s-4 border-amber-500 bg-amber-50 p-3 text-sm">
          <p className="font-medium text-amber-900">{t("home.nextAction")}</p>
          <p className="text-amber-800">{reasonLine(nextAction)}</p>
        </div>
      ) : null}

      <section className="space-y-3">
        <h2 className="text-sm font-semibold text-muted-foreground">{t("home.upcomingRides")}</h2>
        {upcomingRides.length === 0 ? (
          <EmptyState icon={CalendarClock} message={t("home.emptyUpcoming")} />
        ) : (
          <div className="space-y-2">
            {upcomingRides.map((row) => {
              const data = toRideCardData(row);
              return data ? <RideCard key={row.id} ride={data} /> : null;
            })}
          </div>
        )}
      </section>

      {freeCarNow ? (
        <Card
          role="button"
          tabIndex={0}
          className="cursor-pointer transition-colors hover:bg-accent/40"
          onClick={() => setQuickRequestOpen(true)}
        >
          <CardContent className="flex items-center justify-between gap-2 p-4 text-sm">
            <div className="flex items-center gap-2">
              <CarFront className="size-5 text-muted-foreground" aria-hidden="true" />
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

      <section className="space-y-3">
        <h2 className="text-sm font-semibold text-muted-foreground">{t("home.unservedRequests")}</h2>
        {unserved.length === 0 ? (
          <EmptyState icon={MessageCircleQuestion} message={t("home.emptyUnserved")} />
        ) : (
          <div className="space-y-2">
            {unserved.map((row) => (
              <div key={row.id} className="space-y-1 rounded-md border p-3 text-sm">
                <div className="flex items-center justify-between gap-2">
                  <span className="font-medium">{row.destination}</span>
                  <StatusBadge kind="request" status={row.status} />
                </div>
                {row.departAt ? (
                  <span dir="ltr" className="text-xs text-muted-foreground">
                    {formatTime(new Date(row.departAt))}
                  </span>
                ) : null}
                {reasonLine(row) ? (
                  <p className="text-xs text-muted-foreground">{reasonLine(row)}</p>
                ) : null}
              </div>
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
              action={
                <Button asChild size="sm">
                  <Link to="/requests/new">{t("action.newRequest")}</Link>
                </Button>
              }
            />
          ) : (
            <div className="space-y-2">
              {weekRequests.map((row) => (
                <div key={row.id} className="flex items-center justify-between gap-2 rounded-md border p-3 text-sm">
                  <span className="flex items-center gap-2">
                    <CarFront className="size-4 text-muted-foreground" aria-hidden="true" />
                    {row.destination}
                  </span>
                  <StatusBadge kind="request" status={row.status} />
                </div>
              ))}
            </div>
          )}
        </section>
      ) : null}

      <Button asChild size="lg" className="fixed bottom-20 end-4 z-30 rounded-full shadow-lg md:bottom-6">
        <Link to="/requests/new">{t("action.newRequest")}</Link>
      </Button>

      {quickRequestOpen && freeCarNow && defaultDepartmentId && liveWeekStart ? (
        <QuickRequestSheet
          open={quickRequestOpen}
          onOpenChange={setQuickRequestOpen}
          departmentId={defaultDepartmentId}
          weekStart={liveWeekStart}
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
