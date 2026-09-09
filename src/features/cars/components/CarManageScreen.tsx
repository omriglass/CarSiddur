import { formatInTimeZone } from "date-fns-tz";
import { CarFront, Droplets, History as HistoryIcon, Wrench } from "lucide-react";
import type { ReactNode } from "react";
import { useMemo, useState } from "react";

import { CardListSkeleton } from "@/components/skeletons/CardListSkeleton";
import { EmptyState } from "@/components/EmptyState";
import { ErrorState } from "@/components/ErrorState";
import { PageHeader } from "@/components/PageHeader";
import { StatusBadge } from "@/components/StatusBadge";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { CarForm, type ResponsibleOption } from "@/features/admin/cars/components/CarForm";
import type { Car } from "@/features/admin/cars/api";
import { useAllDepartmentMembers, useAllProfiles } from "@/features/admin/members/hooks";
import { CarReportDialog } from "@/features/carCare/components/CarReportDialog";
import { he } from "@/i18n/he";
import { TZ } from "@/lib/time";

import { CarExcelExportButton } from "./CarExcelExportButton";
import { useCarCareHistoryQuery, useCarIssueHistoryQuery } from "../hooks";
import { filterCarHistory, mergeCarHistory, type CarHistoryEntry, type CarHistoryFilter } from "../lib/history";

const TIRE_ORDER: readonly (keyof NonNullable<CarHistoryEntry["tires"]>)[] = [
  "front_left", "front_right", "rear_left", "rear_right", "spare",
];

const TIRE_DOT_CLASS: Record<"ok" | "low" | "very_low", string> = {
  ok: "bg-available",
  low: "bg-maintenance",
  very_low: "bg-destructive",
};

const TIRE_STATE_LABEL: Record<"ok" | "low" | "very_low", string> = {
  ok: he.carPage.exportTireStateOk,
  low: he.carPage.exportTireStateLow,
  very_low: he.carPage.exportTireStateVeryLow,
};

function TireDots({ tires }: { tires: NonNullable<CarHistoryEntry["tires"]> }) {
  return (
    <div className="flex items-center gap-1.5" role="list" aria-label={he.carPage.historyKindTireFill}>
      {TIRE_ORDER.map((position) => (
        <span
          key={position}
          role="listitem"
          aria-label={`${he.carCare.tirePosition[position]}: ${TIRE_STATE_LABEL[tires[position]]}`}
          title={`${he.carCare.tirePosition[position]}: ${TIRE_STATE_LABEL[tires[position]]}`}
          className={`size-2.5 rounded-full ${TIRE_DOT_CLASS[tires[position]]}`}
        />
      ))}
    </div>
  );
}

function historyRow(entry: CarHistoryEntry) {
  const timestamp = formatInTimeZone(new Date(entry.createdAt), TZ, "dd/MM/yyyy HH:mm");
  const icon = entry.kind === "issue" ? Wrench : entry.kind === "tire_fill" ? CarFront : Droplets;
  const Icon = icon;
  return (
    <Card key={`${entry.kind}:${entry.id}`} className="bg-gradient-card shadow-card">
      <CardContent className="flex items-start gap-3 p-3 text-sm">
        <span className="flex size-8 shrink-0 items-center justify-center rounded-full bg-primary/10 text-primary">
          <Icon className="size-4" aria-hidden="true" />
        </span>
        <div className="flex-1 space-y-1">
          <div className="flex items-center justify-between gap-2">
            <span className="font-medium">
              {entry.kind === "issue" && entry.category ? he.carCare.category[entry.category] : he.carPage[
                entry.kind === "issue" ? "historyKindIssue" : entry.kind === "tire_fill" ? "historyKindTireFill" : "historyKindWash"
              ]}
            </span>
            <span className="text-xs text-muted-foreground" dir="ltr">{timestamp}</span>
          </div>
          {entry.kind === "issue" ? (
            <>
              <p className="text-foreground/80">{entry.description}</p>
              <div className="flex gap-2">
                <Badge variant="outline">{entry.status === "resolved" ? he.adminIssues.statusResolved : he.adminIssues.statusOpen}</Badge>
                {entry.isUnsafe ? <Badge variant="destructive">{he.adminIssues.unsafe}</Badge> : null}
              </div>
            </>
          ) : null}
          {entry.kind === "tire_fill" && entry.tires ? <TireDots tires={entry.tires} /> : null}
          {entry.note ? <p className="text-xs text-muted-foreground">{entry.note}</p> : null}
          <p className="text-xs text-muted-foreground">
            {he.carPage.historyReporter} {entry.reporterName ?? entry.reporterId}
          </p>
        </div>
      </CardContent>
    </Card>
  );
}

interface CarManageScreenProps {
  car: Car;
  isAdmin: boolean;
  /** The signed-in viewer's own name — used to show a read-only "אחראי/ת רכב" value when the viewer *is* the responsible person (not an admin, so the field can't be reassigned here, REQ §13.71). */
  viewerName: string;
  /**
   * Extra header actions rendered alongside this screen's own "דיווח על
   * הרכב" button (which opens `CarReportDialog` from `src/features/carCare`
   * directly — filled in 2026-09-09 once that dialog existed). Left as an
   * escape hatch for anything else a future caller wants next to the title.
   */
  headerActions?: ReactNode;
}

/** `/cars/:carId` (UX_FLOWS.md §5.11 "Car page"). */
export function CarManageScreen({ car, isAdmin, viewerName, headerActions }: CarManageScreenProps) {
  const issuesQuery = useCarIssueHistoryQuery(car.id);
  const careEventsQuery = useCarCareHistoryQuery(car.id);
  // Department-members combobox candidates for the responsible-person picker — only fetched (and only
  // rendered as a picker by `CarForm`) when the viewer is an admin; the responsible viewer sees their
  // own name read-only, no fetch needed (`car.responsible_id` already is their own id).
  const deptMembersQuery = useAllDepartmentMembers();
  const profilesQuery = useAllProfiles();

  const [filter, setFilter] = useState<CarHistoryFilter>("all");
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");
  const [reportOpen, setReportOpen] = useState(false);

  const responsibleOptions: ResponsibleOption[] = useMemo(() => {
    if (!isAdmin) {
      return car.responsible_id ? [{ id: car.responsible_id, name: viewerName }] : [];
    }
    const profilesById = new Map((profilesQuery.data ?? []).map((p) => [p.id, p.full_name]));
    return (deptMembersQuery.data ?? [])
      .filter((member) => member.department_id === car.department_id)
      .map((member) => ({ id: member.profile_id, name: profilesById.get(member.profile_id) ?? member.profile_id }))
      .filter((option, index, all) => all.findIndex((o) => o.id === option.id) === index);
  }, [isAdmin, car.responsible_id, car.department_id, viewerName, deptMembersQuery.data, profilesQuery.data]);

  const merged = mergeCarHistory(issuesQuery.data ?? [], careEventsQuery.data ?? []);
  const filtered = filterCarHistory(merged, filter, { from: dateFrom || undefined, to: dateTo || undefined });
  const historyLoading = issuesQuery.isLoading || careEventsQuery.isLoading;
  const historyError = issuesQuery.isError || careEventsQuery.isError;

  const FILTER_CHIPS: { value: CarHistoryFilter; label: string }[] = [
    { value: "all", label: he.carPage.historyFilterAll },
    { value: "issue", label: he.carPage.historyFilterIssue },
    { value: "tire_fill", label: he.carPage.historyFilterTireFill },
    { value: "wash", label: he.carPage.historyFilterWash },
  ];

  return (
    <div className="mx-auto max-w-2xl space-y-4 p-4 pb-24">
      <PageHeader
        title={car.name}
        actions={
          <>
            {headerActions}
            <Button variant="outline" size="sm" onClick={() => setReportOpen(true)}>
              <Wrench className="me-1 size-4" aria-hidden="true" />
              {he.carPage.reportButton}
            </Button>
          </>
        }
      />
      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        <span dir="ltr">{car.license_plate}</span>
        <StatusBadge kind="car" status={car.status} />
      </div>

      <Tabs defaultValue="details">
        <TabsList>
          <TabsTrigger value="details">{he.carPage.tabDetails}</TabsTrigger>
          <TabsTrigger value="history">{he.carPage.tabHistory}</TabsTrigger>
          <TabsTrigger value="export">{he.carPage.tabExport}</TabsTrigger>
        </TabsList>

        <TabsContent value="details" className="pt-4">
          <CarForm
            car={car}
            showDepartmentField={false}
            canEditResponsible={isAdmin}
            canEditSeatConfigs={isAdmin}
            responsibleOptions={responsibleOptions}
            onSaved={() => undefined}
          />
        </TabsContent>

        <TabsContent value="history" className="space-y-4 pt-4">
          <div className="flex flex-wrap gap-2">
            {FILTER_CHIPS.map((chip) => (
              <button
                key={chip.value}
                type="button"
                onClick={() => setFilter(chip.value)}
                className={`rounded-full border px-3 py-1 text-xs transition-smooth ${
                  filter === chip.value ? "border-primary bg-primary/10 text-primary" : "border-border text-muted-foreground"
                }`}
              >
                {chip.label}
              </button>
            ))}
          </div>
          <div className="flex flex-wrap items-end gap-3">
            <label className="flex flex-col gap-1 text-xs text-muted-foreground">
              {he.carPage.historyDateFrom}
              <Input type="date" dir="ltr" value={dateFrom} onChange={(e) => setDateFrom(e.target.value)} className="h-9 w-36" />
            </label>
            <label className="flex flex-col gap-1 text-xs text-muted-foreground">
              {he.carPage.historyDateTo}
              <Input type="date" dir="ltr" value={dateTo} onChange={(e) => setDateTo(e.target.value)} className="h-9 w-36" />
            </label>
          </div>

          {historyLoading ? (
            <CardListSkeleton count={3} />
          ) : historyError ? (
            <ErrorState onRetry={() => { void issuesQuery.refetch(); void careEventsQuery.refetch(); }} />
          ) : filtered.length === 0 ? (
            <EmptyState icon={HistoryIcon} message={he.carPage.historyEmpty} />
          ) : (
            <div className="space-y-2">{filtered.map(historyRow)}</div>
          )}
        </TabsContent>

        <TabsContent value="export" className="pt-4">
          <CarExcelExportButton
            carName={car.name}
            issues={issuesQuery.data ?? []}
            careEvents={careEventsQuery.data ?? []}
            loading={historyLoading}
          />
        </TabsContent>
      </Tabs>

      <CarReportDialog carId={car.id} carName={car.name} open={reportOpen} onOpenChange={setReportOpen} />
    </div>
  );
}
