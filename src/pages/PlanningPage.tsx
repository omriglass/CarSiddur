import { useQueries } from "@tanstack/react-query";
import { CalendarDays, ChevronLeft, ChevronRight, ZoomIn, ZoomOut } from "lucide-react";
import { useMemo, useState } from "react";
import { useParams } from "react-router-dom";

import { todayInJerusalem } from "@/components/dateFieldDates";
import { ErrorState } from "@/components/ErrorState";
import { PageHeader } from "@/components/PageHeader";
import { Button } from "@/components/ui/button";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { CalendarDialog } from "@/features/calendar/CalendarDialog";
import { useCalendarMonthEvents } from "@/features/calendar/useCalendarMonthEvents";
import { useGoogleCalendar } from "@/features/calendar/useGoogleCalendar";
import { DEFAULT_PLANNING_SETTINGS, fetchPlanningMonth, type PlanningDay, type PlanningReservation } from "@/features/planning/api";
import { PlanningDaySheet } from "@/features/planning/components/PlanningDaySheet";
import { PlanningHelper } from "@/features/planning/components/PlanningHelper";
import { PlanningMonthGrid } from "@/features/planning/components/PlanningMonthGrid";
import { monthGridDates } from "@/features/planning/monthGrid";
import { usePlanningSettingsQuery, useTypicalUsageQuery } from "@/features/planning/hooks";
import { planningKeys } from "@/features/planning/keys";
import { PLANNING_ZOOM_MAX, PLANNING_ZOOM_MIN, planningZoomIn, planningZoomOut, readPlanningZoom, writePlanningZoom } from "@/features/planning/zoom";
import { dayLoad, isPlannable, rankOptions, type DayPick, type PickJoin, type RankContext, type RankMode } from "@/features/planning/rank";
import { he, tv } from "@/i18n/he";

/** Reservations reach 92 days ahead (REQ §13.154 a); the view shows the current month through the month of that day. */
const HORIZON_DAYS = 92;

function monthsToShow(today: string): string[] {
  const [y, m] = today.split("-").map(Number) as [number, number];
  const last = new Date(Date.parse(`${today}T12:00:00Z`) + HORIZON_DAYS * 86_400_000).toISOString().slice(0, 7);
  const months: string[] = [];
  for (let i = 0; i < 6; i++) {
    const month = new Date(Date.UTC(y, m - 1 + i, 1)).toISOString().slice(0, 7);
    months.push(month);
    if (month === last) break;
  }
  return months;
}

/**
 * `/plan/:dept` — "תכנון קדימה" (REQ §13.154): the department's reservations over the coming months, the
 * "מתי הכי פנוי?" helper marking the best options on the month, and the member's calendar laid over it
 * (experimental). Phone: one column; computer: the helper beside a large month.
 */
export function PlanningPage() {
  const { dept } = useParams<{ dept: string }>();
  const today = todayInJerusalem();
  const months = useMemo(() => monthsToShow(today), [today]);
  const [monthIndex, setMonthIndex] = useState(0);
  const [picks, setPicks] = useState<Partial<Record<number, DayPick>>>({});
  const [join, setJoin] = useState<PickJoin>("and");
  const [mode, setMode] = useState<RankMode>("reservations");
  const [openDate, setOpenDate] = useState<string | null>(null);
  const [zoom, setZoomState] = useState(readPlanningZoom);
  const setZoom = (next: number) => { setZoomState(next); writePlanningZoom(next); };

  const monthData = useQueries({
    queries: months.map((month) => {
      const grid = monthGridDates(month);
      const from = grid[0] as string;
      const to = grid[grid.length - 1] as string;
      return {
        queryKey: planningKeys.month(dept ?? "", from, to),
        queryFn: () => fetchPlanningMonth(dept as string, from, to),
        enabled: !!dept,
        staleTime: 60_000,
      };
    }),
    combine: (results) => {
      const days = new Map<string, PlanningDay>();
      const reservations = new Map<string, PlanningReservation>();
      for (const result of results) {
        for (const d of result.data?.days ?? []) days.set(d.date, d);
        for (const r of result.data?.reservations ?? []) reservations.set(r.id, r);
      }
      return { days, reservations, failed: results.some((r) => r.isError), refetch: () => results.forEach((r) => void r.refetch()) };
    },
  });
  const { days, reservations } = monthData;
  const settingsQuery = usePlanningSettingsQuery(dept);
  const typicalQuery = useTypicalUsageQuery(dept, mode === "typical");
  const calendar = useGoogleCalendar();
  const [calendarOpen, setCalendarOpen] = useState(false);

  const ctx: RankContext = {
    mode,
    typical: mode === "typical" ? (typicalQuery.data?.byDow ?? null) : null,
    settings: settingsQuery.data ?? DEFAULT_PLANNING_SETTINGS,
  };
  const plannable = (day: PlanningDay) => isPlannable(day, today);
  const stars = useMemo(
    () => rankOptions([...days.values()], picks, join, ctx, today),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- ctx is rebuilt from these each render
    [days, picks, join, mode, typicalQuery.data, settingsQuery.data, today],
  );

  const month = months[monthIndex] ?? months[0]!;
  const grid = monthGridDates(month);
  const events = useCalendarMonthEvents(calendar.available ? grid[0] : undefined, calendar.available ? grid[grid.length - 1] : undefined);
  const [year, monthNo] = month.split("-").map(Number) as [number, number];
  const failed = monthData.failed;
  const openDay = openDate ? days.get(openDate) : undefined;
  const openReservations = (openDay?.reservationIds ?? []).flatMap((id) => reservations.get(id) ?? []);

  return (
    <div className="mx-auto max-w-6xl p-4 pb-24">
      <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:gap-6">
        <aside className="space-y-4 lg:sticky lg:top-4 lg:w-[360px] lg:shrink-0">
          <PageHeader
            title={he.planning.title}
            subtitle={he.planning.subtitle}
            actions={calendar.available ? (
              <Button type="button" variant="outline" size="icon" aria-label={he.calendar.openButton} onClick={() => setCalendarOpen(true)} data-testid="planning-calendar-button">
                <CalendarDays className="size-4" />
              </Button>
            ) : undefined}
          />
          <PlanningHelper picks={picks} onPicksChange={setPicks} join={join} onJoinChange={setJoin} />
          <div className="space-y-1">
            <span className="text-sm text-muted-foreground">{he.planning.modeLabel}</span>
            <ToggleGroup
              type="single"
              value={mode}
              onValueChange={(next) => { if (next) setMode(next as RankMode); }}
              className="justify-start rounded-full bg-muted p-0.5"
              aria-label={he.planning.modeLabel}
            >
              <ToggleGroupItem value="reservations" className="h-8 rounded-full px-3 text-sm data-[state=on]:bg-background data-[state=on]:shadow-sm" data-testid="planning-mode-reservations">{he.planning.modeReservations}</ToggleGroupItem>
              <ToggleGroupItem value="typical" className="h-8 rounded-full px-3 text-sm data-[state=on]:bg-background data-[state=on]:shadow-sm" data-testid="planning-mode-typical">{he.planning.modeTypical}</ToggleGroupItem>
            </ToggleGroup>
            {mode === "typical" && typicalQuery.data && !typicalQuery.data.byDow ? (
              <p className="text-xs text-muted-foreground" data-testid="planning-not-enough-data">{he.planning.notEnoughData}</p>
            ) : null}
          </div>
          <ul className="hidden space-y-1 text-xs text-muted-foreground lg:block">
            <li>{he.planning.legendStars}</li>
            <li>{he.planning.legendShade}</li>
            <li>{he.planning.legendGrey}</li>
          </ul>
        </aside>

        <section className="min-w-0 flex-1 space-y-3 rounded-2xl border bg-card p-2 shadow-sm lg:p-5">
          <div className="flex items-center justify-between">
            <Button type="button" variant="ghost" size="icon" aria-label={he.planning.prevMonth} disabled={monthIndex === 0} onClick={() => setMonthIndex((i) => i - 1)}>
              <ChevronRight className="size-5" aria-hidden="true" />
            </Button>
            <div className="flex items-center gap-1">
              <h2 className="text-lg font-bold lg:text-xl" data-testid="planning-month-title">
                {tv("planning.monthTitle", { month: he.planning.months[monthNo - 1] ?? "", year: String(year) })}
              </h2>
              <Button type="button" variant="ghost" size="icon" className="size-8" aria-label={he.tableView.zoomOut} disabled={zoom <= PLANNING_ZOOM_MIN} onClick={() => setZoom(planningZoomOut(zoom))} data-testid="planning-zoom-out">
                <ZoomOut className="size-4" aria-hidden="true" />
              </Button>
              <button type="button" className="min-w-10 text-xs text-muted-foreground" aria-label={he.tableView.resetZoom} onClick={() => setZoom(PLANNING_ZOOM_MIN)} dir="ltr">
                {Math.round(zoom * 100)}%
              </button>
              <Button type="button" variant="ghost" size="icon" className="size-8" aria-label={he.tableView.zoomIn} disabled={zoom >= PLANNING_ZOOM_MAX} onClick={() => setZoom(planningZoomIn(zoom))} data-testid="planning-zoom-in">
                <ZoomIn className="size-4" aria-hidden="true" />
              </Button>
            </div>
            <Button type="button" variant="ghost" size="icon" aria-label={he.planning.nextMonth} disabled={monthIndex >= months.length - 1} onClick={() => setMonthIndex((i) => i + 1)} data-testid="planning-next-month">
              <ChevronLeft className="size-5" aria-hidden="true" />
            </Button>
          </div>
          {failed ? (
            <ErrorState onRetry={monthData.refetch} />
          ) : (
            <PlanningMonthGrid
              month={month}
              days={days}
              plannable={plannable}
              loadOf={(day) => dayLoad(day, ctx)}
              stars={stars}
              events={events}
              onDayClick={setOpenDate}
              zoom={zoom}
              onZoomChange={setZoom}
            />
          )}
          <ul className="space-y-1 px-1 text-xs text-muted-foreground lg:hidden">
            <li>{he.planning.legendStars}</li>
            <li>{he.planning.legendShade}</li>
            <li>{he.planning.legendGrey}</li>
          </ul>
        </section>
      </div>

      {dept ? (
        <PlanningDaySheet
          departmentId={dept}
          date={openDate}
          day={openDay}
          reservations={openReservations}
          plannable={openDay ? plannable(openDay) : false}
          isPast={!!openDate && openDate <= today}
          events={openDate ? (events.get(openDate) ?? []) : []}
          onOpenChange={(open) => { if (!open) setOpenDate(null); }}
        />
      ) : null}
      {calendar.available ? <CalendarDialog open={calendarOpen} onOpenChange={setCalendarOpen} /> : null}
    </div>
  );
}
