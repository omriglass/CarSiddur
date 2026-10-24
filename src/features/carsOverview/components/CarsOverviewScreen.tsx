import { CarFront, RefreshCw } from "lucide-react";
import type { ReactNode } from "react";
import { useNavigate } from "react-router-dom";

import { paths } from "@/app/routes";
import { EmptyState } from "@/components/EmptyState";
import { ErrorState } from "@/components/ErrorState";
import { PageHeader } from "@/components/PageHeader";
import { CardListSkeleton } from "@/components/skeletons/CardListSkeleton";
import { StatusBadge } from "@/components/StatusBadge";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { formatKm } from "@/features/cars/lib/kilometrage";
import { he, tv } from "@/i18n/he";
import { formatDayDate } from "@/lib/dayLabels";
import { cn } from "@/lib/utils";

import { useCanViewCarsOverview, useCarsOverviewQuery } from "../hooks";

import type { TireState } from "@/lib/enums";
import type { CarOverviewRow, ChecklistStatus } from "../rows";

const t = he.carsOverview;

const TIRE_DOT: Record<TireState, string> = {
  ok: "bg-emerald-500",
  low: "bg-amber-500",
  very_low: "bg-destructive",
  unchecked: "bg-muted-foreground/40",
};
const TIRE_LABEL: Record<TireState, string> = {
  ok: t.tireOk,
  low: t.tireLow,
  very_low: t.tireVeryLow,
  unchecked: t.tireUnchecked,
};

/** Desktop grid: car | km | checklist | tyres | wash | status. Below md every row is a stacked card. */
const GRID = "md:grid md:grid-cols-[minmax(10rem,1.4fr)_1fr_1.3fr_1.3fr_1fr_auto] md:items-center md:gap-3";

function Cell({ label, children, testId }: { label: string; children: ReactNode; testId?: string }) {
  return (
    <div className="flex items-baseline justify-between gap-3 text-sm md:block" data-testid={testId}>
      <span className="text-xs text-muted-foreground md:hidden">{label}</span>
      <span>{children}</span>
    </div>
  );
}

function ChecklistCell({ checklist }: { checklist: ChecklistStatus | null }) {
  if (!checklist) return <span className="text-muted-foreground">{t.noData}</span>;
  const date = formatDayDate(checklist.date);
  if (checklist.green) {
    return <span className="text-emerald-600 dark:text-emerald-400">{tv("carsOverview.checklistGreen", { date })}</span>;
  }
  const label = tv("carsOverview.checklistNotGreen", { date });
  const failed = checklist.failed.join(", ");
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          className="text-destructive underline decoration-dotted"
          title={failed}
          onClick={(event) => event.stopPropagation()}
          data-testid="car-overview-checklist-failed"
        >
          {label}
        </button>
      </PopoverTrigger>
      <PopoverContent className="w-64 text-sm" onClick={(event) => event.stopPropagation()}>
        <p className="mb-1 font-medium">{t.checklistFailedTitle}</p>
        <ul className="list-disc ps-5">
          {checklist.failed.map((item) => <li key={item}>{item}</li>)}
        </ul>
      </PopoverContent>
    </Popover>
  );
}

function CarRow({ row }: { row: CarOverviewRow }) {
  const navigate = useNavigate();
  const open = () => navigate(paths.car(row.id));
  return (
    <div
      role="link"
      tabIndex={0}
      onClick={open}
      onKeyDown={(event) => { if (event.key === "Enter" && event.target === event.currentTarget) open(); }}
      className={cn("cursor-pointer space-y-1.5 rounded-lg border bg-card p-3 shadow-sm transition-smooth hover:bg-accent/40 md:space-y-0 md:rounded-none md:border-0 md:border-b md:bg-transparent md:px-2 md:shadow-none", GRID)}
      data-testid={`car-overview-row-${row.id}`}
    >
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-medium">{row.name}</span>
        <span dir="ltr" className="text-xs text-muted-foreground">{row.licensePlate}</span>
        {row.isReplacement ? <Badge variant="secondary" data-testid="car-overview-replacement">{t.replacement}</Badge> : null}
      </div>
      <Cell label={t.colKm} testId="car-overview-km">
        {row.km ? (
          <>
            <span dir="ltr">{formatKm(row.km.km)}</span>
            <span className="text-xs text-muted-foreground"> · {formatDayDate(row.km.at)}</span>
          </>
        ) : (
          <span className="text-muted-foreground">{t.noReading}</span>
        )}
      </Cell>
      <Cell label={t.colChecklist} testId="car-overview-checklist">
        <ChecklistCell checklist={row.checklist} />
      </Cell>
      <Cell label={t.colTires} testId="car-overview-tires">
        {row.tireFill ? (
          <span className="inline-flex items-center gap-1.5">
            <span className={cn("inline-block size-2.5 rounded-full", TIRE_DOT[row.tireFill.worst])} aria-hidden="true" data-tire-worst={row.tireFill.worst} />
            {formatDayDate(row.tireFill.at)}
            <span className="text-xs text-muted-foreground">{TIRE_LABEL[row.tireFill.worst]}</span>
          </span>
        ) : (
          <span className="text-muted-foreground">{t.neverDone}</span>
        )}
      </Cell>
      <Cell label={t.colWash} testId="car-overview-wash">
        {row.wash ? formatDayDate(row.wash.at) : <span className="text-muted-foreground">{t.neverDone}</span>}
      </Cell>
      <div className="md:justify-self-end"><StatusBadge kind="car" status={row.status} /></div>
    </div>
  );
}

/** `/cars` — the all-cars dashboard for car administrators and admins (REQ item 150 e, UX_FLOWS §5.14). */
export function CarsOverviewScreen() {
  const access = useCanViewCarsOverview();
  const query = useCarsOverviewQuery(access.allowed ? access.departmentId : undefined);

  if (access.isLoading) {
    return <div className="mx-auto max-w-5xl space-y-4 p-4"><PageHeader title={t.title} /><CardListSkeleton count={4} /></div>;
  }
  if (!access.allowed || !access.departmentId) {
    return <div className="mx-auto max-w-5xl p-4"><EmptyState icon={CarFront} message={t.notAuthorized} /></div>;
  }

  return (
    <div className="mx-auto max-w-5xl space-y-3 p-4" data-testid="cars-overview">
      <PageHeader
        title={t.title}
        subtitle={t.subtitle}
        actions={
          <Button type="button" variant="ghost" size="icon" aria-label={t.refresh} title={t.refresh} onClick={() => void query.refetch()}>
            <RefreshCw className={cn("size-4", query.isFetching && "animate-spin")} />
          </Button>
        }
      />
      {query.isLoading ? (
        <CardListSkeleton count={4} />
      ) : query.isError ? (
        <ErrorState onRetry={() => void query.refetch()} />
      ) : !query.rows?.length ? (
        <EmptyState icon={CarFront} message={t.empty} />
      ) : (
        <div className="space-y-2 md:space-y-0">
          <div className={cn("hidden border-b px-2 pb-2 text-xs font-medium text-muted-foreground", GRID)} aria-hidden="true">
            <span>{t.colCar}</span>
            <span>{t.colKm}</span>
            <span>{t.colChecklist}</span>
            <span>{t.colTires}</span>
            <span>{t.colWash}</span>
            <span className="justify-self-end">{t.colStatus}</span>
          </div>
          {query.rows.map((row) => <CarRow key={row.id} row={row} />)}
        </div>
      )}
    </div>
  );
}
