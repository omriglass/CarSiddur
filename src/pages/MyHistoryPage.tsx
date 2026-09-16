import { CalendarClock } from "lucide-react";

import { EmptyState } from "@/components/EmptyState";
import { PageHeader } from "@/components/PageHeader";
import { formatWeekRangeLabel } from "@/components/dateFieldDates";
import { CardListSkeleton } from "@/components/skeletons/CardListSkeleton";
import { RequestRow } from "@/features/requests/components/RequestRow";
import { useMyRequests } from "@/features/requests/hooks";
import { groupByWeek, toDisplayRows } from "@/features/requests/myRequestsRows";
import { isTodayOrLater } from "@/features/requests/upcoming";
import { he } from "@/i18n/he";

/**
 * `/my/history` — read-only list of past requests/rides (REQ §13 item 91, owner 2026-09-16,
 * E3), reachable only from the small "היסטוריה" link at the bottom of `/my`. Lazily loaded
 * (`src/features/member/lazyPages.ts`) since the owner explicitly said this is "not important,
 * must not slow anything". No actions — a past request/ride is history, not a to-do.
 */
export function MyHistoryPage() {
  const requestsQuery = useMyRequests();

  if (requestsQuery.isLoading) {
    return (
      <div className="mx-auto max-w-2xl space-y-6 p-4 pb-24">
        <PageHeader title={he.myHistory.title} />
        <CardListSkeleton />
      </div>
    );
  }

  const now = new Date();
  const pastRows = (requestsQuery.data ?? []).filter((row) => {
    const day = row.ride?.startsAt ?? row.departAt ?? row.returnAt;
    return !!day && !isTodayOrLater(day, now);
  });
  const groups = groupByWeek(toDisplayRows(pastRows));

  return (
    <div className="mx-auto max-w-2xl space-y-6 p-4 pb-24">
      <PageHeader title={he.myHistory.title} />

      {groups.length === 0 ? (
        <EmptyState icon={CalendarClock} message={he.myHistory.empty} />
      ) : (
        groups.map(({ weekStart, departmentId, rows }) => (
          <section key={`${weekStart}:${departmentId}`} className="space-y-2">
            <h2 className="text-sm font-semibold text-muted-foreground" dir="ltr">
              {formatWeekRangeLabel(weekStart)}
            </h2>
            <div className="space-y-2">
              {rows.map((row) => <RequestRow key={row.id} row={row} readOnly />)}
            </div>
          </section>
        ))
      )}
    </div>
  );
}
