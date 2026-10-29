import { useMemo, useState, type ReactNode } from "react";
import { History } from "lucide-react";
import { Link } from "react-router-dom";

import { paths } from "@/app/routes";
import { ConsentChip } from "@/components/ConsentChip";
import { DeltaTag } from "@/components/RideDeltaLine";
import { EmptyState } from "@/components/EmptyState";
import { PageHeader } from "@/components/PageHeader";
import { StatusBadge } from "@/components/StatusBadge";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { useDestinations } from "@/features/fleet/hooks";
import { useDepartments } from "@/features/siddur/hooks";
import { he, tv } from "@/i18n/he";
import { formatDayDate } from "@/lib/dayLabels";
import { describeStatusReason } from "@/lib/statusReason";
import { formatTime } from "@/lib/time";
import { cn } from "@/lib/utils";

import { useAllWeekRides, useAuditLog, useCarsForDepartment, useProposalsForWeek, useWeekRequestsWithNames } from "../../hooks";
import { requestDeltas } from "../../requestDelta";
import { requestHistory } from "../auditSentences";
import { changeLogRows, closedReasonOf, filterChangeLogRows, groupRowsByDay, isClosedBySadran, type ChangeLogRow } from "../changeLogRows";
import { RestoreClosedAction } from "./RestoreClosedAction";

interface ChangeLogScreenProps {
  departmentId: string;
  weekStart: string;
}

const PLACE_LABEL = { origin: he.rideDelta.from, destination: he.rideDelta.to, stops: he.rideDelta.via } as const;

function pair(start: string | null | undefined, end: string | null | undefined): string {
  const a = start ? formatTime(new Date(start)) : null;
  const b = end ? formatTime(new Date(end)) : null;
  return a && b ? `${a}–${b}` : (a ?? b ?? "");
}

/** `/sadran/:dept/:week/log` - requested vs got, one row per request (REQ §13.161 d; UX_FLOWS.md §4.6). */
export function ChangeLogScreen({ departmentId, weekStart }: ChangeLogScreenProps) {
  const requests = useWeekRequestsWithNames(departmentId, weekStart);
  const rides = useAllWeekRides(departmentId, weekStart);
  const proposals = useProposalsForWeek(departmentId, weekStart);
  const cars = useCarsForDepartment(departmentId);
  const audit = useAuditLog(departmentId, weekStart);
  const departments = useDepartments();
  const destinations = useDestinations(departmentId);

  const [onlyBeyondFlex, setOnlyBeyondFlex] = useState(true);
  const [day, setDay] = useState<string | null>(null);
  const [query, setQuery] = useState("");

  const homeId = (departments.data ?? []).find((department) => department.id === departmentId)?.home_destination_id;
  const homeName = homeId ? (destinations.data ?? []).find((place) => place.id === homeId)?.name ?? null : null;
  const deltas = useMemo(
    () => requestDeltas(requests.data ?? [], rides.data ?? [], proposals.data ?? [], { homeName }),
    [requests.data, rides.data, proposals.data, homeName],
  );
  const allRows = useMemo(() => changeLogRows(requests.data ?? [], deltas, onlyBeyondFlex), [requests.data, deltas, onlyBeyondFlex]);
  const days = useMemo(() => [...new Set(allRows.map((row) => row.day))], [allRows]);
  const rows = filterChangeLogRows(allRows, { day: day && days.includes(day) ? day : null, query });
  const groups = groupRowsByDay(rows);

  const loading = requests.isLoading || rides.isLoading;
  const failed = requests.isError || rides.isError;
  const carName = (id: string) => (cars.data ?? []).find((car) => car.id === id)?.name ?? "";

  function openHref(row: ChangeLogRow) {
    return paths.sadran.board(departmentId, weekStart, { day: row.day, rideId: row.rideId ?? undefined });
  }

  return (
    <div className="mx-auto max-w-5xl space-y-3 p-4 pb-24" data-testid="change-log">
      <PageHeader title={he.screen.log.title} />

      <div className="space-y-2">
        <Input type="search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder={he.sadranLog.searchPlaceholder} aria-label={he.sadranLog.searchPlaceholder} className="min-h-11 md:max-w-xs" />
        <div className="flex flex-wrap gap-1.5" role="group">
          <DayPill active={!day} onClick={() => setDay(null)}>{he.sadranLog.allWeek}</DayPill>
          {days.map((value) => <DayPill key={value} active={day === value} onClick={() => setDay(value)}>{formatDayDate(value)}</DayPill>)}
        </div>
        <div className="flex min-h-11 items-center gap-2">
          <Switch id="change-log-beyond-flex" checked={onlyBeyondFlex} onCheckedChange={setOnlyBeyondFlex} />
          <Label htmlFor="change-log-beyond-flex" className="text-sm font-normal">
            {he.sadranLog.onlyBeyondFlex} · {tv("sadranLog.requestCount", { count: String(rows.length) })}
          </Label>
        </div>
      </div>

      {loading ? <p className="text-muted-foreground">{he.common.loading}</p>
        : failed ? <p role="alert">{he.sadranLog.loadError}</p>
        : rows.length === 0 ? <EmptyState icon={History} message={allRows.length ? he.sadranLog.emptyFiltered : he.sadranLog.empty} />
        : (
          <>
            {/* Phone: cards grouped by day. */}
            <div className="space-y-1 md:hidden">
              {groups.map((group) => (
                <section key={group.day} className="space-y-2">
                  <h2 className="px-1 pt-2 text-sm font-semibold text-muted-foreground">{formatDayDate(group.day)}</h2>
                  {group.rows.map((row) => (
                    <Card key={row.request.id} data-change-log-request={row.request.id}>
                      <CardContent className="space-y-1.5 p-3 text-sm">
                        <div className="flex items-center justify-between gap-2">
                          <Link to={openHref(row)} title={he.sadranLog.openOnBoard} className="min-h-11 content-center font-semibold hover:underline">{row.request.requester_full_name ?? he.deviations.noName}</Link>
                          <StateCell row={row} />
                        </div>
                        <p className="text-xs text-muted-foreground">{route(row)}</p>
                        <dl className="grid grid-cols-[auto_1fr] gap-x-2.5 gap-y-0.5">
                          <GotLines row={row} carName={carName} labelled closedReason={closedReasonOf(audit.data ?? [], row.request.id)} />
                        </dl>
                        <ClosedRestore row={row} departmentId={departmentId} weekStart={weekStart} />
                        <RequestHistory row={row} audit={audit.data ?? []} proposals={proposals.data ?? []} />
                      </CardContent>
                    </Card>
                  ))}
                </section>
              ))}
            </div>

            {/* Computer: one table. */}
            <div className="hidden overflow-x-auto md:block">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b text-xs text-muted-foreground">
                    {[he.sadranLog.colDay, he.sadranLog.colMember, he.sadranLog.colAsked, he.sadranLog.colGot, he.sadranLog.colState].map((label) => (
                      <th key={label} className="px-1.5 py-2 text-start font-semibold">{label}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {rows.map((row) => (
                    <tr key={row.request.id} className="border-b align-top" data-change-log-request={row.request.id}>
                      <td className="px-1.5 py-2">{formatDayDate(row.day)}</td>
                      <td className="px-1.5 py-2">
                        <Link to={openHref(row)} title={he.sadranLog.openOnBoard} className="font-semibold hover:underline">{row.request.requester_full_name ?? he.deviations.noName}</Link>
                        <span className="block text-xs text-muted-foreground">{route(row)}</span>
                      </td>
                      <td className="px-1.5 py-2">
                        <span dir="ltr" className="tabular-nums">{pair(askedStart(row), askedEnd(row))}</span>
                      </td>
                      <td className="space-y-0.5 px-1.5 py-2">
                        <GotLines row={row} carName={carName} closedReason={closedReasonOf(audit.data ?? [], row.request.id)} />
                        <RequestHistory row={row} audit={audit.data ?? []} proposals={proposals.data ?? []} />
                      </td>
                      <td className="space-y-1 px-1.5 py-2"><StateCell row={row} /><ClosedRestore row={row} departmentId={departmentId} weekStart={weekStart} /></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
    </div>
  );
}

const askedStart = (row: ChangeLogRow) => row.delta.depart?.asked ?? row.request.original_depart_at ?? row.request.depart_at;
const askedEnd = (row: ChangeLogRow) => row.delta.return?.asked ?? row.request.original_return_at ?? row.request.return_at;

function route(row: ChangeLogRow): string {
  const from = row.request.origin_resolved_name ?? row.request.origin_text;
  const to = row.request.destination_resolved_name ?? row.request.destination_text ?? "";
  return from ? `${from} ← ${to}` : `← ${to}`;
}

function DayPill({ active, onClick, children }: { active: boolean; onClick: () => void; children: string }) {
  return (
    <button type="button" aria-pressed={active} onClick={onClick}
      className={cn("min-h-11 rounded-full border px-3 text-xs", active ? "border-primary bg-primary text-primary-foreground" : "bg-card")}>
      {children}
    </button>
  );
}

/** The state chip: a refusal / no-ride state through `StatusBadge`, otherwise where the member's consent stands. */
function StateCell({ row }: { row: ChangeLogRow }) {
  const { delta, request } = row;
  if (delta.state !== "placed") return <StatusBadge kind="request" status={request.status} />;
  return <ConsentChip state={delta.consent} className="text-xs" />;
}

/** REQ §13.162 (d): a request the Sadran closed can be put back on the waiting list from here (and only here). */
function ClosedRestore({ row, departmentId, weekStart }: { row: ChangeLogRow; departmentId: string; weekStart: string }) {
  if (!isClosedBySadran(row.request)) return null;
  return <RestoreClosedAction requestId={row.request.id} version={row.request.version} name={row.request.requester_full_name ?? ""} departmentId={departmentId} weekStart={weekStart} />;
}

/** What the request got: hours, changed places, people, the car, who it rides with, or why it was not placed. */
function GotLines({ row, carName, labelled = false, closedReason = null }: { row: ChangeLogRow; carName: (id: string) => string; labelled?: boolean; closedReason?: string | null }) {
  const { delta, request } = row;
  const lines: { label: string; node: ReactNode }[] = [];
  if (delta.depart || delta.return) {
    const changed = !!delta.depart?.beyondFlex || !!delta.return?.beyondFlex;
    const text = pair(delta.depart?.got ?? askedStart(row), delta.return?.got ?? askedEnd(row));
    lines.push({ label: he.sadranLog.hours, node: <span dir="ltr" className="tabular-nums">{changed ? <DeltaTag>{text}</DeltaTag> : text}</span> });
  }
  for (const place of delta.places) {
    lines.push({ label: PLACE_LABEL[place.kind], node: <><span className="text-muted-foreground line-through">{place.asked}</span> <DeltaTag>{place.got}</DeltaTag></> });
  }
  if (delta.peopleAdded.length) lines.push({ label: he.sadranLog.people, node: delta.peopleAdded.map((name) => <DeltaTag key={name} className="me-1">{tv("rideDelta.added", { name })}</DeltaTag>) });
  if (delta.peopleMissing.length) lines.push({ label: he.sadranLog.people, node: <DeltaTag>{tv("sadranLog.peopleMissing", { names: delta.peopleMissing.join(", ") })}</DeltaTag> });
  if (delta.ridesWith) lines.push({ label: he.sadranLog.car, node: <DeltaTag>{tv("sadranLog.ridesWith", { name: delta.ridesWith })}</DeltaTag> });
  if (delta.car) lines.push({ label: he.sadranLog.car, node: tv("sadranLog.carChange", { asked: carName(delta.car.askedCarId), got: carName(delta.car.gotCarId) }) });
  if (delta.state !== "placed") {
    const reason = describeStatusReason(request.status_reason);
    lines.push({ label: he.sadranLog.reason, node: reason ?? he.sadranLog.noRide });
    if (closedReason && isClosedBySadran(request)) lines.push({ label: he.sadranLog.reason, node: tv("closeRequest.closedReason", { reason: closedReason }) });
  }
  if (!lines.length) return <span className="text-muted-foreground">{he.sadranLog.noRide}</span>;
  return (
    <>
      {lines.map((line, index) => labelled ? (
        <div key={index} className="contents">
          <dt className="text-xs text-muted-foreground">{line.label}</dt>
          <dd>{line.node}</dd>
        </div>
      ) : <span key={index} className="block">{line.node}</span>)}
    </>
  );
}

/** "איך הגענו לכאן (n)": the request's, its rides' and its proposals' audit rows as short sentences. */
function RequestHistory({ row, audit, proposals }: { row: ChangeLogRow; audit: Parameters<typeof requestHistory>[0]; proposals: readonly { id: string; request_id: string }[] }) {
  const lines = requestHistory(audit, {
    requestId: row.request.id,
    rideIds: row.delta.rideIds,
    proposalIds: proposals.filter((proposal) => proposal.request_id === row.request.id).map((proposal) => proposal.id),
  });
  return (
    <details className="text-xs text-muted-foreground">
      <summary className="min-h-6 cursor-pointer text-primary">{tv("sadranLog.historyToggle", { count: String(lines.length) })}</summary>
      {lines.length === 0 ? <p>{he.sadranLog.historyEmpty}</p> : (
        <ul className="mt-1 list-disc space-y-0.5 ps-4">
          {lines.map((line) => (
            <li key={line.id}>
              <span dir="ltr">{formatDayDate(line.at)} {formatTime(new Date(line.at))}</span> {line.actor}: {line.what}
            </li>
          ))}
        </ul>
      )}
    </details>
  );
}
