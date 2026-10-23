// REQ §13.101 (c, QM2): the Sadran assigns a volunteer driver (found by phone) to a ride that
// needs one, replaces a volunteer in one step (R8U1) or takes the volunteer off it again (`set_ride_driver`). The driver and the passengers
// are notified by the RPC. A driver who drives their own request is replaceable too (owner 2026-10-16: the request moves to the
// new driver, the old one stays its filer) after a confirm line, but is not removable.
import { useState } from "react";
import { toast } from "sonner";

import { ConfirmDialog } from "@/components/ConfirmDialog";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { he, tv } from "@/i18n/he";
import { formatTime } from "@/lib/time";
import { cn } from "@/lib/utils";

import { useSetRideDriverMutation } from "../../hooks";
import { filterDriverCandidates, sortFreeFirst, type PersonDayEntry } from "../driverBusy";

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

export function RideDriverPicker({ rideId, version, needsDriver, volunteerName, volunteerId, ownRequest, candidates, departmentId, weekStart, busyIds, dayEntriesOf, placeName, homeDestinationId, disabled, published = true, onDone }: RideDriverPickerProps) {
  const [driverId, setDriverId] = useState("");
  const [confirming, setConfirming] = useState(false);
  const [query, setQuery] = useState("");
  const [freeOnly, setFreeOnly] = useState(false);
  // A new ride or ride version (someone assigned/replaced the driver) starts with an empty choice. Derived during render, not via a
  // `key` on the element: a keyed picker inside the sheet was rendered twice when a Select in the sheet opened.
  const [seen, setSeen] = useState(`${rideId}:${version}`);
  if (seen !== `${rideId}:${version}`) {
    setSeen(`${rideId}:${version}`);
    setDriverId("");
  }
  const mutation = useSetRideDriverMutation();
  const drivers = sortFreeFirst(candidates.filter((candidate) => !candidate.doesNotDrive && candidate.id !== volunteerId), busyIds ?? new Set<string>());

  // The chosen person stays in the list even when the filter would hide them.
  const shown = filterDriverCandidates(drivers, query, freeOnly, busyIds ?? new Set<string>()).concat(drivers.filter((d) => d.id === driverId && !filterDriverCandidates(drivers, query, freeOnly, busyIds ?? new Set<string>()).includes(d)));

  if (!needsDriver && !volunteerName) return null;
  const livesAway = (candidate: DriverCandidate) => (candidate.homePlaceId && candidate.homePlaceId !== homeDestinationId ? placeName?.(candidate.homePlaceId) ?? null : null);

  function assign() {
    setConfirming(false);
    const chosen = drivers.find((candidate) => candidate.id === driverId);
    if (!chosen) return;
    mutation.mutate({ rideId, driverId: chosen.id, expectedVersion: version, departmentId, weekStart }, {
      onSuccess: () => { setDriverId(""); toast.success(tv(published ? (volunteerName ? "rideDriver.replaced" : "rideDriver.assigned") : "rideDriver.assignedUnpublished", { name: chosen.name })); onDone?.(); },
    });
  }
  function unassign() {
    mutation.mutate({ rideId, driverId: null, expectedVersion: version, departmentId, weekStart }, {
      onSuccess: () => { toast.success(he.rideDriver.unassigned); onDone?.(); },
    });
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
      <Input value={query} onChange={(event) => setQuery(event.target.value)} className="min-h-11" placeholder={he.rideDriver.searchPlaceholder} aria-label={he.rideDriver.searchPlaceholder} data-testid="ride-driver-search" />
      {busyIds?.size ? (
        <label className="flex min-h-9 items-center gap-2 text-sm">
          <Checkbox checked={freeOnly} onCheckedChange={(value) => setFreeOnly(value === true)} data-testid="ride-driver-free-only" />
          {he.rideDriver.freeOnly}
        </label>
      ) : null}
      {shown.length === 0 ? <p className="text-xs text-muted-foreground" data-testid="ride-driver-no-match">{he.rideDriver.noMatch}</p> : null}
      <div className="flex items-center gap-2">
        <Select value={driverId} onValueChange={setDriverId} disabled={disabled || mutation.isPending}>
          <SelectTrigger className="min-h-11 flex-1" aria-label={he.rideDriver.selectAria} data-testid="ride-driver-select">
            <SelectValue placeholder={he.rideDriver.placeholder} />
          </SelectTrigger>
          <SelectContent>
            {shown.map((candidate) => <SelectItem key={candidate.id} value={candidate.id}>{[candidate.name, livesAway(candidate), busyIds?.has(candidate.id) ? he.rideDriver.busy : null].filter(Boolean).join(" · ")}</SelectItem>)}
          </SelectContent>
        </Select>
        <Button type="button" className="min-h-11" disabled={!driverId || disabled || mutation.isPending} onClick={ownRequest ? () => setConfirming(true) : assign} data-testid="ride-driver-assign">
          {volunteerName ? he.rideDriver.replace : he.rideDriver.assign}
        </Button>
      </div>
      {driverId && dayEntriesOf ? <DayEntries name={drivers.find((candidate) => candidate.id === driverId)?.name ?? ""} entries={dayEntriesOf(driverId)} /> : null}
      <ConfirmDialog open={confirming} onOpenChange={setConfirming} title={he.rideDriver.replaceOwnTitle}
        description={tv("rideDriver.replaceOwnConfirm", { name: drivers.find((candidate) => candidate.id === driverId)?.name ?? "", old: volunteerName ?? "" })}
        confirmLabel={he.rideDriver.replace} loading={mutation.isPending} onConfirm={assign} />
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
