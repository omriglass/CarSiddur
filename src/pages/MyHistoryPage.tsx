import { useState } from "react";
import { CalendarClock } from "lucide-react";

import { EmptyState } from "@/components/EmptyState";
import { Button } from "@/components/ui/button";
import { PageHeader } from "@/components/PageHeader";
import { formatWeekRangeLabel } from "@/components/dateFieldDates";
import { CardListSkeleton } from "@/components/skeletons/CardListSkeleton";
import { useActiveDepartment } from "@/features/auth/useActiveDepartment";
import { useSession } from "@/features/auth/useSession";
import { ClosedRequestsList } from "@/features/requests/components/ClosedRequestsList";
import { RequestHistoryDialog } from "@/features/requests/components/RequestHistoryDialog";
import { RequestRow } from "@/features/requests/components/RequestRow";
import { closedByWeek } from "@/features/requests/closedByWeek";
import { useMyClosedRequests, useMyRequests } from "@/features/requests/hooks";
import { groupByWeek, toDisplayRows } from "@/features/requests/myRequestsRows";
import { isTodayOrLater } from "@/features/requests/upcoming";
import { he } from "@/i18n/he";

/**
 * `/my/history` — read-only list of past requests/rides (REQ §13 item 91, owner 2026-09-16,
 * E3), reachable only from the small "היסטוריה" link at the bottom of `/my`. Lazily loaded
 * (`src/features/member/lazyPages.ts`) since the owner explicitly said this is "not important,
 * must not slow anything". No actions — a past request/ride is history, not a to-do. REQ §13.204 (d): also every
 * withdrawn / cancelled / closed request, and "what happened?" on each row.
 */
export function MyHistoryPage() {
  const requestsQuery = useMyRequests();
  const closedQuery = useMyClosedRequests();
  const [historyId, setHistoryId] = useState<string | null>(null);
  const viewerId = useSession().session?.user.id;
  // REQ §13.93: `departments.home_destination_id` per department, for `RequestRow`'s "מ<origin>
  // ל<destination>" display.
  const active = useActiveDepartment();
  const homeDestinationIds = Object.fromEntries(active.departments.map((d) => [d.id, d.home_destination_id]));

  if (requestsQuery.isLoading || closedQuery.isLoading) {
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
  const closedWeeks = [...closedByWeek(closedQuery.data ?? [])].reverse();

  return (
    <div className="mx-auto max-w-2xl space-y-6 p-4 pb-24">
      <PageHeader title={he.myHistory.title} />

      {closedWeeks.length ? (
        <section className="space-y-3" data-testid="history-closed">
          <h2 className="font-semibold">{he.myHistory.closedTitle}</h2>
          {closedWeeks.map(([key, rows]) => (
            <div key={key} className="space-y-2">
              <h3 className="text-sm font-semibold text-muted-foreground" dir="ltr">{formatWeekRangeLabel(key.split(":")[0] ?? "")}</h3>
              <ClosedRequestsList rows={rows} />
            </div>
          ))}
        </section>
      ) : null}

      {closedWeeks.length ? <h2 className="font-semibold">{he.myHistory.pastTitle}</h2> : null}
      {groups.length === 0 ? (
        <EmptyState icon={CalendarClock} message={he.myHistory.empty} />
      ) : (
        groups.map(({ weekStart, departmentId, rows }) => (
          <section key={`${weekStart}:${departmentId}`} className="space-y-2">
            <h2 className="text-sm font-semibold text-muted-foreground" dir="ltr">
              {formatWeekRangeLabel(weekStart)}
            </h2>
            <div className="space-y-2">
              {rows.map((row) => (
                <div key={row.id} className="space-y-0.5">
                  <RequestRow row={row} homeDestinationId={homeDestinationIds[departmentId]} viewerId={viewerId} readOnly />
                  <Button type="button" variant="link" size="sm" className="min-h-11 px-1" onClick={() => setHistoryId(row.id)} data-testid="past-request-history">
                    {he.requestHistory.open}
                  </Button>
                </div>
              ))}
            </div>
          </section>
        ))
      )}
      {historyId ? <RequestHistoryDialog requestId={historyId} open onOpenChange={(value) => { if (!value) setHistoryId(null); }} /> : null}
    </div>
  );
}
