import { Archive } from "lucide-react";
import { Link, useParams } from "react-router-dom";

import { formatWeekRangeLabel, todayInJerusalem } from "@/components/DateField";
import { EmptyState } from "@/components/EmptyState";
import { PageHeader } from "@/components/PageHeader";
import { StatusBadge } from "@/components/StatusBadge";
import { CardListSkeleton } from "@/components/skeletons/CardListSkeleton";
import { useActiveDepartment } from "@/features/auth/useActiveDepartment";
import { MemberWeekExportButton } from "@/features/siddur/components/MemberWeekExportButton";
import { useWeeks } from "@/features/siddur/hooks";
import { pastWeeks } from "@/features/siddur/pastWeeks";
import { he, t } from "@/i18n/he";
import { paths } from "@/app/routes";

/**
 * `/siddur/:dept/archive` — read-only list of past siddurim (Archive of past
 * siddurim, owner decision 2026-09-10). Past weeks no longer appear in the
 * regular week switcher/strip (`SiddurPage.tsx`); this is the only place
 * they are still reachable, open to every approved member of the
 * department (not just its Sadran/admin).
 */
export function SiddurArchivePage() {
  const params = useParams<{ dept?: string }>();
  const active = useActiveDepartment();
  const departmentId = params.dept ?? active.departmentId;
  const weeksQuery = useWeeks(departmentId);
  const weeks = pastWeeks(weeksQuery.data ?? [], todayInJerusalem());

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

      {weeksQuery.isLoading ? (
        <CardListSkeleton />
      ) : weeks.length === 0 ? (
        <EmptyState icon={Archive} message={he.siddur.archiveEmpty} />
      ) : (
        <ul className="space-y-2">
          {weeks.map((week) => (
            <li key={week.week_start} className="flex items-center justify-between gap-2 rounded-md border p-3">
              <Link
                to={departmentId ? paths.siddur({ dept: departmentId, week: week.week_start }) : "#"}
                className="flex min-w-0 flex-1 items-center gap-2"
                data-testid="siddur-archive-row"
              >
                <span dir="ltr" className="text-sm font-medium">{formatWeekRangeLabel(week.week_start)}</span>
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
