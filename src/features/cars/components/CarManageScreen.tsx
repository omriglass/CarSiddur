import { CarMaintenancePanel } from "@/features/fleet/components/CarMaintenancePanel";
import { formatInTimeZone } from "date-fns-tz";
import type { TireState } from "@/lib/enums";
import { CarFront, ClipboardList, Droplets, Fuel, History as HistoryIcon, Route, Wrench } from "lucide-react";
import type { ReactNode } from "react";
import { useMemo, useState } from "react";

import { CardListSkeleton } from "@/components/skeletons/CardListSkeleton";
import { EmptyState } from "@/components/EmptyState";
import { ErrorState } from "@/components/ErrorState";
import { PageHeader } from "@/components/PageHeader";
import { StatusBadge } from "@/components/StatusBadge";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { ResponsibleOption } from "@/features/admin/cars/components/CarForm";
import type { Car } from "@/features/admin/cars/api";
import { useAllDepartmentMembers, useAllProfiles } from "@/features/admin/members/hooks";
import { CarSparkle } from "@/components/CarSparkle";
import { useRecentlyWashedCarIds } from "@/features/carCare/hooks";
import { CarNameWithReport } from "@/features/carCare/components/CarNameWithReport";
import { CarReportDialog } from "@/features/carCare/components/CarReportDialog";
import { CarTasksManagerCard } from "@/features/carTasks/components/CarTasksManagerCard";
import { useCarTasksQuery } from "@/features/carTasks/hooks";
import { he, tv } from "@/i18n/he";
import { formatDayDate } from "@/lib/dayLabels";
import { TZ } from "@/lib/time";

import { CarExcelExportButton } from "./CarExcelExportButton";
import { CarFuelChip } from "./CarFuelChip";
import { CarMoodFace } from "./CarMoodFace";
import { CarOwnersCard } from "./CarOwnersCard";
import { CarKilometrageCard } from "./CarKilometrageCard";
import { CarChecklistCard } from "../checklist/components/CarChecklistCard";
import { CarGuidesCard } from "../guides/components/CarGuidesCard";
import { CarFactsCard } from "./CarFactsCard";
import { CarIssueSheet, type IssueTarget } from "./CarIssueSheet";
import { CarOpenIssues } from "./CarOpenIssues";
import { CarRegistrationCard } from "./CarRegistrationCard";
import { CarReportsSection, type CarReportView } from "./CarReportsSection";
import { CarStatusSelect } from "./CarStatusSelect";
import { useCarCareHistoryQuery, useCarCurrentKmQuery, useCarIssueHistoryQuery, useCarOdometerHistoryQuery, useOpenCarIssuesQuery } from "../hooks";
import { formatPlate } from "@/lib/plate";
import { isCarOwner } from "@/lib/carOwners";
import { useProfile } from "@/features/auth/useProfile";
import { formatKm } from "../lib/kilometrage";
import { filterCarHistory, mergeCarHistory, type CarHistoryEntry, type CarHistoryFilter } from "../lib/history";

const TIRE_ORDER: readonly (keyof NonNullable<CarHistoryEntry["tires"]>)[] = [
  "front_left", "front_right", "rear_left", "rear_right", "spare",
];

const TIRE_DOT_CLASS: Record<TireState, string> = {
  unchecked: "border border-muted-foreground/50 bg-transparent",
  ok: "bg-available",
  low: "bg-maintenance",
  very_low: "bg-destructive",
};

const TIRE_STATE_LABEL: Record<TireState, string> = {
  unchecked: he.carPage.exportTireStateUnchecked,
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

function historyRow(entry: CarHistoryEntry, onIssue?: (entry: CarHistoryEntry) => void) {
  const timestamp = formatInTimeZone(new Date(entry.createdAt), TZ, "dd/MM/yyyy HH:mm");
  const icon = entry.kind === "issue" ? Wrench : entry.kind === "tire_fill" ? CarFront : entry.kind === "kilometrage" ? Route : entry.kind === "task" ? ClipboardList : entry.kind === "urea_fill" ? Fuel : Droplets;
  const Icon = icon;
  return (
    <Card
      key={`${entry.kind}:${entry.id}`}
      className={`bg-gradient-card shadow-card${onIssue ? " cursor-pointer hover:border-primary/50" : ""}`}
      {...(onIssue ? {
        role: "button", tabIndex: 0, "data-testid": "car-history-open-issue",
        onClick: () => onIssue(entry),
        onKeyDown: (event: React.KeyboardEvent) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); onIssue(entry); } },
      } : {})}
    >
      <CardContent className="flex items-start gap-3 p-3 text-sm">
        <span className="flex size-8 shrink-0 items-center justify-center rounded-full bg-primary/10 text-primary">
          <Icon className="size-4" aria-hidden="true" />
        </span>
        <div className="flex-1 space-y-1">
          <div className="flex items-center justify-between gap-2">
            <span className="font-medium">
              {entry.kind === "task" ? he.carTasks.historyKind : entry.kind === "issue" && entry.category ? he.carCare.category[entry.category] : he.carPage[
                entry.kind === "issue"
                  ? "historyKindIssue"
                  : entry.kind === "tire_fill"
                    ? "historyKindTireFill"
                    : entry.kind === "kilometrage"
                      ? entry.odometerKind === "correction" ? "historyKindKilometrageCorrection" : "historyKindKilometrage"
                      : entry.kind === "urea_fill" ? "historyKindUreaFill" : "historyKindWash"
              ]}
            </span>
            <span className="text-xs text-muted-foreground" dir="ltr">{timestamp}</span>
          </div>
          {entry.kind === "issue" ? (
            <>
              <p className="text-foreground/80">{entry.description}</p>
              <div className="flex gap-2">
                {entry.status ? <StatusBadge kind="carIssue" status={entry.status} /> : null}
                {entry.isUnsafe ? <Badge variant="destructive">{he.adminIssues.unsafe}</Badge> : null}
              </div>
              {entry.status === "resolved" && entry.closedAt ? (
                <p className="text-xs text-muted-foreground" data-testid="car-history-issue-resolved">
                  {entry.closedByName
                    ? tv("carPage.issueResolvedBy", { name: entry.closedByName, date: formatInTimeZone(new Date(entry.closedAt), TZ, "dd/MM/yyyy HH:mm") })
                    : tv("carPage.issueResolvedAt", { date: formatInTimeZone(new Date(entry.closedAt), TZ, "dd/MM/yyyy HH:mm") })}
                </p>
              ) : null}
            </>
          ) : null}
          {entry.kind === "kilometrage" && entry.km !== undefined ? (
            <p className="text-foreground/80" dir="ltr" data-testid="car-history-km">{tv("carPage.historyKm", { km: formatKm(entry.km) })}</p>
          ) : null}
          {entry.kind === "task" && entry.taskKind ? (
            <>
              <p className="text-foreground/80" data-testid="car-history-task">{entry.taskKind === "other" ? entry.note : he.carTasks.kind[entry.taskKind]}</p>
              <p className="text-xs text-muted-foreground">
                {entry.taskStatus === "done"
                  ? tv("carTasks.statusDone", { name: entry.closedByName ?? "", date: entry.closedAt ? formatInTimeZone(new Date(entry.closedAt), TZ, "dd/MM/yyyy HH:mm") : "" })
                  : entry.taskStatus === "withdrawn"
                    ? tv("carTasks.statusWithdrawn", { date: entry.closedAt ? formatInTimeZone(new Date(entry.closedAt), TZ, "dd/MM/yyyy HH:mm") : "" })
                    : he.carTasks.statusOpen}
              </p>
            </>
          ) : null}
          {entry.kind === "tire_fill" && entry.tires ? <TireDots tires={entry.tires} /> : null}
          {entry.note && entry.kind !== "task" ? <p className="text-xs text-muted-foreground">{entry.note}</p> : null}
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
  /** REQ item 150 (a), `can_manage_car`: admin, the car's responsible person or (shared car) a department car administrator — may correct the kilometrage. */
  canManageCar: boolean;
  /** REQ item 150 (d): admin or a car administrator of the car's department — may edit the department's checklist items. */
  canDefineChecklist?: boolean;
  /** REQ item 150 (a): a car administrator (not admin/responsible) looking at a private car — may change only its status. */
  canSetStatusOnly?: boolean;
  /** PC1 (REQ item 227 b): the department's Sadran or an admin may add/remove a private car's owners (its owners always may). */
  canManageOwners?: boolean;
  /** Admin, the car's responsible person or the department's Sadran: may edit fields, the private switch, maintenance. Everyone else gets a read-only page. */
  canEdit: boolean;
  /**
   * Extra header actions slot, empty by default — the car report dialog now
   * opens from the header's own car icon (`CarNameWithReport`, replacing the
   * title text), not a dedicated button here. Left as an escape hatch for
   * anything else a future caller wants next to the title.
   */
  headerActions?: ReactNode;
  /** R20U10: whether the viewer may read the car's codes (a member of its department, or an admin). */
  codeVisible?: boolean;
}

/** `/cars/:carId` (UX_FLOWS.md §5.11 "Car page"). */
export function CarManageScreen({ car, isAdmin, canEdit, canManageCar, canDefineChecklist = false, canSetStatusOnly = false, canManageOwners = false, codeVisible = true, headerActions }: CarManageScreenProps) {
  const washed = useRecentlyWashedCarIds(car.department_id);
  const issuesQuery = useCarIssueHistoryQuery(car.id);
  const careEventsQuery = useCarCareHistoryQuery(car.id);
  const odometerQuery = useCarOdometerHistoryQuery(car.id);
  const currentKmQuery = useCarCurrentKmQuery(car.id);
  const tasksQuery = useCarTasksQuery(car.id, canManageCar);
  // Department-members combobox candidates for the responsible-person picker — only fetched (and only
  // rendered as a picker by `CarForm`) when the viewer is an admin; everyone else sees the responsible
  // person's name read-only, looked up in the profiles every approved member may read.
  const deptMembersQuery = useAllDepartmentMembers();
  const profilesQuery = useAllProfiles();

  const [filter, setFilter] = useState<CarHistoryFilter>("all");
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");
  const [logView, setLogView] = useState<"km" | CarReportView | null>(null);
  const [historyAll, setHistoryAll] = useState(false);
  const [selectedIssue, setSelectedIssue] = useState<(IssueTarget & { reporterId?: string | null }) | null>(null);
  const openIssuesQuery = useOpenCarIssuesQuery([car.id]);
  const profile = useProfile().data;

  const responsibleOptions: ResponsibleOption[] = useMemo(() => {
    const profilesById = new Map((profilesQuery.data ?? []).map((p) => [p.id, p.full_name]));
    if (!isAdmin) {
      // Read-only value for every other viewer: the car's real responsible person (owner 2026-11-07, CR1), not the viewer.
      return car.responsible_id ? [{ id: car.responsible_id, name: profilesById.get(car.responsible_id) ?? "" }] : [];
    }
    return (deptMembersQuery.data ?? [])
      .filter((member) => member.department_id === car.department_id)
      .map((member) => ({ id: member.profile_id, name: profilesById.get(member.profile_id) ?? member.profile_id }))
      .filter((option, index, all) => all.findIndex((o) => o.id === option.id) === index);
  }, [isAdmin, car.responsible_id, car.department_id, deptMembersQuery.data, profilesQuery.data]);

  const merged = mergeCarHistory(issuesQuery.data ?? [], careEventsQuery.data ?? [], odometerQuery.data ?? [], tasksQuery.data ?? []);
  const lastUreaAt = merged.find((entry) => entry.kind === "urea_fill")?.createdAt ?? null;
  const filtered = filterCarHistory(merged, filter, { from: dateFrom || undefined, to: dateTo || undefined });
  const historyLoading = issuesQuery.isLoading || careEventsQuery.isLoading || odometerQuery.isLoading;
  const historyError = issuesQuery.isError || careEventsQuery.isError || odometerQuery.isError;

  const FILTER_CHIPS: { value: CarHistoryFilter; label: string }[] = [
    { value: "all", label: he.carPage.historyFilterAll },
    { value: "issue", label: he.carPage.historyFilterIssue },
    { value: "tire_fill", label: he.carPage.historyFilterTireFill },
    { value: "wash", label: he.carPage.historyFilterWash },
    ...(car.fuel_type === "diesel" ? [{ value: "urea_fill" as const, label: he.carPage.historyFilterUrea }] : []),
    { value: "kilometrage", label: he.carPage.historyFilterKilometrage },
    ...(canManageCar ? [{ value: "task" as const, label: he.carTasks.historyFilter }] : []),
  ];

  // CR1 (REQ item 257, owner 2026-11-20): one page ordered by who needs what — everyone, good to know, the car's managers.
  const asOwner = car.type === "temporary" && isCarOwner(car, profile?.id);
  const showManage = canEdit || canManageCar || canSetStatusOnly || asOwner;
  // CR2 (REQ item 257 b): the car's managers and the department's Sadran handle its open issues (update_car_issue re-checks).
  const canHandleIssues = canEdit || canManageCar;
  const openIssueFromHistory = (entry: CarHistoryEntry) =>
    setSelectedIssue({ id: entry.id, description: entry.description ?? "", createdAt: entry.createdAt, isUnsafe: !!entry.isUnsafe, reporterId: entry.reporterId });
  const shown = historyAll ? filtered : filtered.slice(0, 3);
  const tier = (label: string) => (
    <h2 className="flex items-center gap-2 pt-2 text-xs font-semibold text-muted-foreground after:h-px after:flex-1 after:bg-border">{label}</h2>
  );

  return (
    <div className="mx-auto max-w-2xl space-y-3 p-4 pb-24">
      <PageHeader
        title={
          <span className="relative inline-flex items-center gap-1 px-2">
            <CarNameWithReport carId={car.id} carName={car.name} />
            {washed?.has(car.id) ? <CarSparkle /> : null}
          </span>
        }
        actions={headerActions}
      />
      {/* FU1 (REQ item 217): licence plate and fuel type are the first facts about a car. */}
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <span className="font-medium" dir="ltr" data-testid="car-plate">{formatPlate(car.license_plate)}</span>
        <CarFuelChip fuel={car.fuel_type} />
        <StatusBadge kind="car" status={car.status} />
        {careEventsQuery.isSuccess ? <CarMoodFace lastWashAt={merged.find((entry) => entry.kind === "wash")?.createdAt ?? null} /> : null}
        {/* Owner 2026-11-13: the last urea fill at a glance on a diesel car. */}
        {car.fuel_type === "diesel" ? (
          <span className="text-xs text-muted-foreground" data-testid="car-last-urea">
            {lastUreaAt ? tv("carPage.lastUreaFill", { date: formatDayDate(lastUreaAt) }) : he.carPage.lastUreaNever}
          </span>
        ) : null}
      </div>

      <CarOpenIssues
        issues={openIssuesQuery.data ?? []}
        variant="banner"
        canSelect={(issue) => canHandleIssues || issue.reported_by === profile?.id}
        onSelect={(issue) => setSelectedIssue({ id: issue.id, description: issue.description, createdAt: issue.created_at, isUnsafe: issue.is_unsafe, reporterId: issue.reported_by })}
      />
      <CarIssueSheet
        car={car}
        issue={selectedIssue}
        onClose={() => setSelectedIssue(null)}
        canManage={canHandleIssues}
        canReword={!!selectedIssue && selectedIssue.reporterId === profile?.id}
      />

      {tier(he.carPage.tierEveryone)}
      <CarFactsCard
        car={car}
        canEdit={canEdit}
        canEditResponsible={isAdmin}
        responsibleOptions={responsibleOptions}
        codeVisible={codeVisible}
      />
      <CarOwnersCard car={car} canManageOwners={canManageOwners} />
      <CarMaintenancePanel car={car} />
      {/* REQ item 264: the next passenger's requests, then one collapsible "דיווחים"; the car check is in it for managers only. */}
      {canManageCar ? <CarTasksManagerCard car={car} /> : null}
      <CarReportsSection carId={car.id} isDiesel={car.fuel_type === "diesel"} onReport={setLogView}>
        {/* A replacement car has its own odometer: no readings into the regular car's history while it is replaced. */}
        {car.is_replaced ? null : (
          <CarKilometrageCard car={car} current={currentKmQuery.data ?? null} loading={currentKmQuery.isLoading} canCorrect={canManageCar} onLogKm={() => setLogView("km")} />
        )}
        {showManage ? <CarChecklistCard car={car} canManageCar={canManageCar} canDefine={canDefineChecklist} /> : null}
      </CarReportsSection>
      {/* R20U3 (QA run 20): the report rows and cards open their step of the car report dialog. */}
      {logView ? <CarReportDialog carId={car.id} carName={car.name} open initialView={logView} onOpenChange={(open) => { if (!open) setLogView(null); }} /> : null}

      {tier(he.carPage.tierMore)}
      <section className="space-y-3" data-testid="car-history">
        <h3 className="text-sm font-semibold">{he.carPage.tabHistory}</h3>
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
        {historyAll ? (
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
        ) : null}

        {historyLoading ? (
          <CardListSkeleton count={3} />
        ) : historyError ? (
          <ErrorState onRetry={() => { void issuesQuery.refetch(); void careEventsQuery.refetch(); void odometerQuery.refetch(); }} />
        ) : filtered.length === 0 ? (
          <EmptyState icon={HistoryIcon} message={he.carPage.historyEmpty} />
        ) : (
          <div className="space-y-2">
            {shown.map((entry) => historyRow(entry, entry.kind === "issue" && entry.status === "open" && (canHandleIssues || entry.reporterId === profile?.id) ? openIssueFromHistory : undefined))}
          </div>
        )}
        {!historyAll && filtered.length > shown.length ? (
          <Button variant="ghost" size="sm" onClick={() => setHistoryAll(true)} data-testid="car-history-all">
            {tv("carPage.historyShowAll", { count: String(filtered.length) })}
          </Button>
        ) : null}
      </section>

      {showManage ? (
        <>
          {tier(he.carPage.tierManage)}
          {canSetStatusOnly && !canEdit ? <CarStatusSelect car={car} /> : null}
          <CarRegistrationCard car={car} canEdit={canEdit} canEditSeatConfigs={isAdmin || (canEdit && car.type === "temporary")} />
          {canEdit || canManageCar ? (
            <CarExcelExportButton
              carName={car.name}
              issues={issuesQuery.data ?? []}
              careEvents={careEventsQuery.data ?? []}
              odometer={odometerQuery.data ?? []}
              tasks={tasksQuery.data ?? []}
              loading={historyLoading}
            />
          ) : null}
        </>
      ) : null}
      {/* REQ item 264: the guides are read now and then and rarely edited - last on the page. */}
      <CarGuidesCard car={car} canManage={canManageCar} canDefine={canDefineChecklist} />
    </div>
  );
}
