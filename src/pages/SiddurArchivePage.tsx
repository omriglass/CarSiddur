import { Archive } from "lucide-react";
import { Link, useParams, useSearchParams } from "react-router-dom";

import { formatWeekRangeLabelWithYear, todayInJerusalem } from "@/components/dateFieldDates";
import { EmptyState } from "@/components/EmptyState";
import { PageHeader } from "@/components/PageHeader";
import { StatusBadge } from "@/components/StatusBadge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { CardListSkeleton } from "@/components/skeletons/CardListSkeleton";
import { useActiveDepartment } from "@/features/auth/useActiveDepartment";
import { MemberWeekExportButton } from "@/features/siddur/components/MemberWeekExportButton";
import { useWeeks } from "@/features/siddur/hooks";
import { pastWeeks, weeksInDateRange } from "@/features/siddur/pastWeeks";
import { he, t } from "@/i18n/he";
import { paths } from "@/app/routes";

/**
 * `/siddur/:dept/archive` — read-only list of past siddurim (Archive of past
 * siddurim, owner decision 2026-09-10). Past weeks no longer appear in the
 * regular week switcher/strip (`SiddurPage.tsx`); this is the only place
 * they are still reachable, open to every approved member of the
 * department (not just its Sadran/admin). Owner 2026-10-25: a date search (one date = its week, with "עד" = every
 * week in the range; kept in `?from=&to=` so coming back from a week keeps it) and week labels with the year.
 */
export function SiddurArchivePage() {
  const params = useParams<{ dept?: string }>();
  const active = useActiveDepartment();
  const departmentId = params.dept ?? active.departmentId;
  const weeksQuery = useWeeks(departmentId);
  const [searchParams, setSearchParams] = useSearchParams();
  const from = searchParams.get("from") ?? "";
  const to = searchParams.get("to") ?? "";
  const allWeeks = pastWeeks(weeksQuery.data ?? [], todayInJerusalem());
  const weeks = weeksInDateRange(allWeeks, from, to);
  const setRange = (next: { from?: string; to?: string }) => {
    const params = new URLSearchParams(searchParams);
    for (const [key, value] of Object.entries(next)) {
      if (value) params.set(key, value);
      else params.delete(key);
    }
    setSearchParams(params, { replace: true });
  };

  return (
    <div className="mx-auto max-w-2xl space-y-4 p-4 pb-24">
      <PageHeader
        title={t("siddur.archiveTitle")}
        actions={
          departmentId ? (
            <Link to={paths.siddur({ dept: departmentId })} className="text-sm font-medium text-primary underline">
              {he.common.back}
            </Link>
          ) : undefined
        }
      />

      {allWeeks.length > 0 ? (
        <div className="flex flex-wrap items-end gap-3" data-testid="siddur-archive-search">
          <div className="flex flex-col gap-1">
            <Label htmlFor="archive-date-from">{he.siddur.archiveDate}</Label>
            <Input id="archive-date-from" type="date" dir="ltr" value={from} onChange={(event) => setRange({ from: event.target.value })} className="min-h-11 w-40" />
          </div>
          <div className="flex flex-col gap-1">
            <Label htmlFor="archive-date-to">{he.siddur.archiveDateTo}</Label>
            <Input id="archive-date-to" type="date" dir="ltr" value={to} min={from || undefined} onChange={(event) => setRange({ to: event.target.value })} className="min-h-11 w-40" />
          </div>
          {from || to ? (
            <Button type="button" variant="ghost" className="min-h-11" onClick={() => setRange({ from: "", to: "" })}>{he.siddur.archiveDateClear}</Button>
          ) : null}
        </div>
      ) : null}

      {weeksQuery.isLoading ? (
        <CardListSkeleton />
      ) : allWeeks.length === 0 ? (
        <EmptyState icon={Archive} message={he.siddur.archiveEmpty} />
      ) : weeks.length === 0 ? (
        <EmptyState icon={Archive} message={he.siddur.archiveNoMatch} />
      ) : (
        <ul className="space-y-2">
          {weeks.map((week) => (
            <li key={week.week_start} className="flex items-center justify-between gap-2 rounded-md border p-3">
              <Link
                to={departmentId ? paths.siddur({ dept: departmentId, week: week.week_start }) : "#"}
                className="flex min-w-0 flex-1 items-center gap-2"
                data-testid="siddur-archive-row"
              >
                <span dir="ltr" className="text-sm font-medium">{formatWeekRangeLabelWithYear(week.week_start)}</span>
                <StatusBadge kind="week" status={week.phase} />
              </Link>
              {departmentId ? (
                <MemberWeekExportButton departmentId={departmentId} weekStart={week.week_start} />
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
