import { CalendarClock, CarFront, Inbox, MessageCircleQuestion } from "lucide-react";
import { Link } from "react-router-dom";

import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/EmptyState";
import { PageHeader } from "@/components/PageHeader";
import { RideCard, type RideCardData } from "@/components/RideCard";
import { StatusBadge } from "@/components/StatusBadge";
import { formatWeekRangeLabel } from "@/components/DateField";
import { useMyDepartments } from "@/features/auth/useMyDepartments";
import { useProfile } from "@/features/auth/useProfile";
import { useMyRequests } from "@/features/requests/hooks";
import type { MyRequestRow } from "@/features/requests/api";
import { useWeeks } from "@/features/siddur/hooks";
import { he, t, tv } from "@/i18n/he";
import { formatTime } from "@/lib/time";

import { hasRideTodayOrTomorrow, resolveHomeWeek } from "./homeWeek";

const UNSERVED_STATUSES = new Set<MyRequestRow["status"]>(["waitlisted", "denied", "proposed"]);

function toRideCardData(row: MyRequestRow): RideCardData | null {
  if (!row.ride) return null;
  return {
    id: row.ride.id,
    startsAt: row.ride.startsAt,
    endsAt: row.ride.endsAt,
    originName: row.ride.originName,
    destinationName: row.ride.destinationName,
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

  const defaultDepartmentId =
    profileQuery.data?.default_department_id ?? departmentsQuery.data?.[0]?.department_id;
  const weeksQuery = useWeeks(defaultDepartmentId);

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
  const now = new Date();

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
    </div>
  );
}
