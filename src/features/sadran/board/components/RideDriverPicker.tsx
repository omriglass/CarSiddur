// REQ §13.101 (c, QM2): the Sadran assigns a volunteer driver (found by phone) to a ride that
// needs one, replaces a volunteer in one step (R8U1) or takes the volunteer off it again (`set_ride_driver`). The driver and the passengers
// are notified by the RPC. A driver who drives their own request is replaceable too (owner 2026-10-16: the request moves to the
// new driver, the old one stays its filer) after a confirm line, but is not removable.
import { useState, type KeyboardEvent } from "react";
import { toast } from "sonner";

import { ConfirmDialog } from "@/components/ConfirmDialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { he, tv } from "@/i18n/he";
import { formatTime } from "@/lib/time";
import { cn } from "@/lib/utils";

import { useSetRideDriverMutation } from "../../hooks";
import { filterDriverCandidates, sortFreeFirst, type PersonDayEntry } from "../driverBusy";
import { useRecordBoardUndo } from "../boardUndo";

export interface DriverCandidate {
  id: string;
  name: string;
  doesNotDrive?: boolean;
  /** R4U5: the member's own home place when it is not the department's (null/undefined = home). */
  homePlaceId?: string | null;
}

export interface RideDriverPickerProps {
  rideId: string;
  version: number;
  needsDriver: boolean;
  /** The current driver of a driven ride that is removable (a volunteer), else null. */
  volunteerName: string | null;
  /** R8U1: the volunteer's profile id, left out of the replacement list. */
  volunteerId?: string | null;
  /** The current driver drives their own request on this ride: replacing moves that request to the new driver (confirm first); no removal. */
  ownRequest?: boolean;
  candidates: readonly DriverCandidate[];
  departmentId: string;
  weekStart: string;
  /** R2U3: members busy during the ride (own ride/request overlapping); marked, and listed after the free ones. */
  busyIds?: ReadonlySet<string>;
  /** R13F2: the candidate's other rides and requests on the ride's day, shown once one is chosen. */
  dayEntriesOf?: (personId: string) => PersonDayEntry[];
  /** R4U5: where members live, shown next to the name when not the department home. */
  placeName?: (placeId: string) => string | undefined;
  homeDestinationId?: string | null;
  disabled?: boolean;
  /** R6B15: false on an unpublished (draft) day — nothing is sent, so the toast says "saved". Default true. */
  published?: boolean;
  /** Called after a successful assign/remove (R3B16: the sheet closes). */
  onDone?: () => void;
}

const MAX_ROWS = 8;
const EMPTY_QUERY_ROWS = 5;

export function RideDriverPicker({ rideId, version, needsDriver, volunteerName, volunteerId, ownRequest, candidates, departmentId, weekStart, busyIds, dayEntriesOf, placeName, homeDestinationId, disabled, published = true, onDone }: RideDriverPickerProps) {
  const [driverId, setDriverId] = useState("");
  const [confirming, setConfirming] = useState(false);
  const [query, setQuery] = useState("");
  // Owner 2026-11-09: a ride that has a driver shows one line until the Sadran asks to replace them (rarely needed).
  const [expanded, setExpanded] = useState(false);
  // A new ride or ride version (someone assigned/replaced the driver) starts with an empty choice. Derived during render, not via a
  // `key` on the element: a keyed picker inside the sheet was rendered twice when a Select in the sheet opened.
  const [seen, setSeen] = useState(`${rideId}:${version}`);
  if (seen !== `${rideId}:${version}`) {
    setSeen(`${rideId}:${version}`);
    setDriverId("");
    setExpanded(false);
  }
  const mutation = useSetRideDriverMutation();
  const recordUndo = useRecordBoardUndo();
  const drivers = sortFreeFirst(candidates.filter((candidate) => !candidate.doesNotDrive && candidate.id !== volunteerId), busyIds ?? new Set<string>());

  const busy = busyIds ?? new Set<string>();
  // Matches show at once under the search box (no dropdown): free people first, at most MAX_ROWS; the chosen person always stays.
  const found = filterDriverCandidates(drivers, query, false, busy).slice(0, query.trim() ? MAX_ROWS : EMPTY_QUERY_ROWS);
  const chosenRow = drivers.find((d) => d.id === driverId);
  const shown = chosenRow && !found.includes(chosenRow) ? [...found, chosenRow] : found;

  if (!needsDriver && !volunteerName) return null;
  const livesAway = (candidate: DriverCandidate) => (candidate.homePlaceId && candidate.homePlaceId !== homeDestinationId ? placeName?.(candidate.homePlaceId) ?? null : null);

  function assign(id: string = driverId) {
    setConfirming(false);
    const chosen = drivers.find((candidate) => candidate.id === id);
    if (!chosen) return;
    void recordUndo(he.sadranBoard.undoLabel.driver, () => mutation.mutateAsync({ rideId, driverId: chosen.id, expectedVersion: version, departmentId, weekStart }, {
      onSuccess: () => { setDriverId(""); toast.success(tv(published ? (volunteerName ? "rideDriver.replaced" : "rideDriver.assigned") : "rideDriver.assignedUnpublished", { name: chosen.name })); onDone?.(); },
    })).catch(() => undefined);
  }
  function assignOrConfirm(id: string) {
    setDriverId(id);
    if (ownRequest) setConfirming(true); else assign(id);
  }
  function onSearchKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (!shown.length) return;
    const index = shown.findIndex((candidate) => candidate.id === driverId);
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      const next = event.key === "ArrowDown" ? Math.min(index + 1, shown.length - 1) : Math.max(index - 1, 0);
      setDriverId(shown[next]!.id);
    } else if (event.key === "Enter") {
      event.preventDefault();
      if (disabled || mutation.isPending) return;
      assignOrConfirm((index >= 0 ? shown[index] : shown[0])!.id);
    }
  }
  function unassign() {
    void recordUndo(he.sadranBoard.undoLabel.driver, () => mutation.mutateAsync({ rideId, driverId: null, expectedVersion: version, departmentId, weekStart }, {
      onSuccess: () => { toast.success(he.rideDriver.unassigned); onDone?.(); },
    })).catch(() => undefined);
  }

  if (!needsDriver && !expanded) {
    return (
      <div className="flex flex-wrap items-center justify-between gap-2 rounded-md border p-3" data-testid="ride-driver-picker">
        <p>{tv(ownRequest ? "rideDriver.currentOwn" : "rideDriver.current", { name: volunteerName ?? "" })}</p>
        <div className="flex flex-wrap gap-2">
          <Button type="button" variant="outline" className="min-h-11" disabled={disabled} onClick={() => setExpanded(true)} data-testid="ride-driver-expand">
            {he.rideDriver.expand}
          </Button>
          {ownRequest ? null : (
            <Button type="button" variant="outline" className="min-h-11" disabled={disabled || mutation.isPending} onClick={unassign} data-testid="ride-driver-unassign">
              {he.rideDriver.unassign}
            </Button>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-2 rounded-md border p-3" data-testid="ride-driver-picker">
      {volunteerName && !ownRequest ? (
        <div className="flex items-center justify-between gap-2">
          <p>{tv("rideDriver.current", { name: volunteerName })}</p>
          <Button type="button" variant="outline" className="min-h-11" disabled={disabled || mutation.isPending} onClick={unassign} data-testid="ride-driver-unassign">
            {he.rideDriver.unassign}
          </Button>
        </div>
      ) : null}
      <p className="text-xs text-muted-foreground">{volunteerName ? (ownRequest ? tv("rideDriver.replaceOwnLabel", { name: volunteerName }) : he.rideDriver.replaceLabel) : he.rideDriver.assignLabel}</p>
      <Input value={query} onChange={(event) => setQuery(event.target.value)} onKeyDown={onSearchKeyDown} className="min-h-11" placeholder={he.rideDriver.searchPlaceholder} aria-label={he.rideDriver.searchPlaceholder} data-testid="ride-driver-search" />
      {shown.length === 0 && query.trim() ? <p className="text-xs text-muted-foreground" data-testid="ride-driver-no-match">{he.rideDriver.noMatch}</p> : null}
      {shown.length > 0 ? (
        <div role="listbox" aria-label={he.rideDriver.selectAria} className="space-y-1" data-testid="ride-driver-list">
          {shown.map((candidate) => {
            const selected = candidate.id === driverId;
            const isBusy = busy.has(candidate.id);
            const away = livesAway(candidate);
            return (
              <div key={candidate.id} role="option" aria-selected={selected} tabIndex={-1} data-testid="ride-driver-option" data-driver-id={candidate.id}
                onClick={() => setDriverId(candidate.id)}
                className={cn("flex min-h-11 cursor-pointer items-center justify-between gap-2 rounded-md border px-3 py-1 text-sm", selected ? "border-primary bg-accent" : "hover:bg-muted", isBusy && !selected && "text-muted-foreground")}>
                <span>{[candidate.name, away, isBusy ? he.rideDriver.busy : null].filter(Boolean).join(" · ")}</span>
                {selected ? (
                  <Button type="button" size="sm" className="min-h-9" disabled={disabled || mutation.isPending}
                    onClick={(event) => { event.stopPropagation(); if (ownRequest) setConfirming(true); else assign(candidate.id); }} data-testid="ride-driver-assign">
                    {volunteerName ? he.rideDriver.replace : he.rideDriver.assign}
                  </Button>
                ) : null}
              </div>
            );
          })}
        </div>
      ) : null}
      {driverId && dayEntriesOf ? <DayEntries name={drivers.find((candidate) => candidate.id === driverId)?.name ?? ""} entries={dayEntriesOf(driverId)} /> : null}
      <ConfirmDialog open={confirming} onOpenChange={setConfirming} title={he.rideDriver.replaceOwnTitle}
        description={tv("rideDriver.replaceOwnConfirm", { name: drivers.find((candidate) => candidate.id === driverId)?.name ?? "", old: volunteerName ?? "" })}
        confirmLabel={he.rideDriver.replace} loading={mutation.isPending} onConfirm={() => assign()} />
    </div>
  );
}

/** Exported for its test: the Radix Select is impractical to drive in jsdom. */
export function DayEntries({ name, entries }: { name: string; entries: readonly PersonDayEntry[] }) {
  return (
    <div className="space-y-1 text-xs" data-testid="ride-driver-day">
      <p className="text-muted-foreground">{tv("rideDriver.dayTitle", { name })}</p>
      {entries.length ? (
        <ul className="space-y-0.5">
          {entries.map((entry) => (
            <li key={`${entry.kind}:${entry.startsAt}`} className={cn(entry.overlaps && "font-semibold text-destructive")} data-testid="ride-driver-day-entry">
              {he.rideDriver.dayKind[entry.kind]} · <span dir="ltr" className="tabular-nums">{formatTime(new Date(entry.startsAt))}–{formatTime(new Date(entry.endsAt))}</span>
              {entry.destination ? ` · ${tv("rideDriver.dayDestination", { place: entry.destination })}` : ""}
              {entry.overlaps ? ` · ${he.rideDriver.dayOverlap}` : ""}
            </li>
          ))}
        </ul>
      ) : <p className="text-muted-foreground">{he.rideDriver.dayNone}</p>}
    </div>
  );
}
