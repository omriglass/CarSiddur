import { BarChart3 } from "lucide-react";
import { useMemo, useState } from "react";
import { useParams } from "react-router-dom";

import { todayInJerusalem } from "@/components/DateField";
import { EmptyState } from "@/components/EmptyState";
import { ErrorState } from "@/components/ErrorState";
import { PageHeader } from "@/components/PageHeader";
import { CardListSkeleton } from "@/components/skeletons/CardListSkeleton";
import { StatsDateRangePicker } from "@/features/stats/components/StatsDateRangePicker";
import { StatsDepartmentSwitcher } from "@/features/stats/components/StatsDepartmentSwitcher";
import { StatTile } from "@/features/stats/components/StatTile";
import { WeekdayBarList } from "@/features/stats/components/WeekdayBarList";
import { formatDateDMY, formatDecimal, formatPercent } from "@/features/stats/format";
import { useCanViewDepartmentStats, useDepartmentStatsQuery } from "@/features/stats/hooks";
import { computePresetRange, DEFAULT_STATS_PRESET } from "@/features/stats/presets";
import { he, tv } from "@/i18n/he";

/**
 * `/stats/:dept` — usage statistics for admins and department Sadranim
 * (owner request, UX_FLOWS.md §5.12). Role check is client-side convenience
 * only, same pattern as `CarPage`; `department_stats` itself is the real
 * guarantee (RLS/`security definer`, CLAUDE.md Conventions "Roles").
 */
export function StatsPage() {
  const { dept } = useParams<{ dept: string }>();
  const access = useCanViewDepartmentStats(dept);
  const defaultRange = useMemo(() => computePresetRange(DEFAULT_STATS_PRESET, todayInJerusalem()), []);
  // The range the user asked for (drives the query key); the RPC clamps `from`/`to` server-side
  // (never before the department's `earliest` data, never after today) and is the single source
  // of truth for the *effective* range shown in the inputs — see `displayedRange` below, computed
  // straight from the response with no extra state/effect (owner feedback, UX_FLOWS.md §5.12).
  const [requestedRange, setRequestedRange] = useState(defaultRange);

  const statsQuery = useDepartmentStatsQuery(dept, requestedRange.from, requestedRange.to);
  const stats = statsQuery.data;
  const earliest = stats?.earliest;
  const displayedRange = stats ? { from: stats.from, to: stats.to } : requestedRange;

  if (access.isLoading) {
    return (
      <div className="mx-auto max-w-4xl space-y-4 p-4">
        <PageHeader title={he.stats.title} />
        <CardListSkeleton count={4} />
      </div>
    );
  }

  if (!dept || !access.allowed) {
    return (
      <div className="mx-auto max-w-4xl p-4">
        <EmptyState icon={BarChart3} message={he.errors.notAuthorized} />
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-4xl space-y-4 p-4 pb-24">
      <PageHeader
        title={he.stats.title}
        subtitle={he.stats.subtitle}
        actions={
          access.options.length > 1 ? (
            <StatsDepartmentSwitcher departmentId={dept} options={access.options} />
          ) : undefined
        }
      />

      <StatsDateRangePicker value={displayedRange} onChange={setRequestedRange} earliest={earliest} />

      {statsQuery.isLoading ? (
        <CardListSkeleton count={4} />
      ) : statsQuery.isError ? (
        <ErrorState onRetry={() => void statsQuery.refetch()} />
      ) : !stats || stats.days === 0 ? (
        <EmptyState icon={BarChart3} message={he.stats.empty} />
      ) : (
        <>
          <div className="grid grid-cols-2 gap-3 md:grid-cols-4" data-testid="stats-tiles">
            <StatTile
              testId="stats-tile-utilization"
              label={he.stats.tiles.utilization.label}
              value={<span dir="ltr">{formatPercent(stats.utilization.rate)}</span>}
              sub={
                <>
                  <span dir="ltr">{formatDecimal(stats.utilization.activeHours)}</span>{" "}
                  {he.stats.tiles.utilization.subOf} <span dir="ltr">{stats.utilization.capacityHours}</span>{" "}
                  {he.stats.tiles.utilization.subUnit}
                </>
              }
              help={he.stats.tiles.utilization.help}
              footnote={he.stats.capacityFormula}
            />
            <StatTile
              testId="stats-tile-unmet"
              label={he.stats.tiles.unmet.label}
              value={<span dir="ltr">{formatPercent(stats.requests.unmetRate)}</span>}
              sub={
                <>
                  <span dir="ltr">{stats.requests.unmet}</span> {he.stats.tiles.unmet.subOf}{" "}
                  <span dir="ltr">{stats.requests.total}</span> {he.stats.tiles.unmet.subUnit}
                </>
              }
              help={he.stats.tiles.unmet.help}
            />
            <StatTile
              testId="stats-tile-rides"
              label={he.stats.tiles.rides.label}
              value={<span dir="ltr">{stats.rides}</span>}
              help={he.stats.tiles.rides.help}
            />
            <StatTile
              testId="stats-tile-policy-score"
              label={he.stats.tiles.policyScore.label}
              value={
                stats.policyScore.average === null ? (
                  he.stats.tiles.policyScore.noData
                ) : (
                  <span dir="ltr">{formatDecimal(stats.policyScore.average, 2)}</span>
                )
              }
              sub={
                stats.policyScore.average === null ? undefined : (
                  <>
                    <span dir="ltr">{stats.policyScore.weeks}</span> {he.stats.tiles.policyScore.subUnit}
                  </>
                )
              }
              help={he.stats.tiles.policyScore.help}
            />
          </div>

          <p className="text-xs text-muted-foreground" data-testid="stats-effective-range">
            {tv("stats.effectiveRange", {
              from: formatDateDMY(stats.from),
              to: formatDateDMY(stats.to),
              days: String(stats.days),
            })}
          </p>

          <WeekdayBarList days={stats.byWeekday} />
        </>
      )}
    </div>
  );
}
