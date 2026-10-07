// REQ §13.101 (c, QM2): the Sadran assigns a volunteer driver (found by phone) to a ride that
// needs one, or takes a volunteer off it again (`set_ride_driver`). The driver and the passengers
// are notified by the RPC. A driver who has a request of their own on the ride is not removable.
import { useState } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { he, tv } from "@/i18n/he";

import { useSetRideDriverMutation } from "../../hooks";
import { sortFreeFirst } from "../driverBusy";

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
  candidates: readonly DriverCandidate[];
  departmentId: string;
  weekStart: string;
  /** R2U3: members busy during the ride (own ride/request overlapping); marked, and listed after the free ones. */
  busyIds?: ReadonlySet<string>;
  /** R4U5: where members live, shown next to the name when not the department home. */
  placeName?: (placeId: string) => string | undefined;
  homeDestinationId?: string | null;
  disabled?: boolean;
  /** R6B15: false on an unpublished (draft) day — nothing is sent, so the toast says "saved". Default true. */
  published?: boolean;
  /** Called after a successful assign/remove (R3B16: the sheet closes). */
  onDone?: () => void;
}

export function RideDriverPicker({ rideId, version, needsDriver, volunteerName, candidates, departmentId, weekStart, busyIds, placeName, homeDestinationId, disabled, published = true, onDone }: RideDriverPickerProps) {
  const [driverId, setDriverId] = useState("");
  const mutation = useSetRideDriverMutation();
  const drivers = sortFreeFirst(candidates.filter((candidate) => !candidate.doesNotDrive), busyIds ?? new Set<string>());

  if (!needsDriver && !volunteerName) return null;
  const livesAway = (candidate: DriverCandidate) => (candidate.homePlaceId && candidate.homePlaceId !== homeDestinationId ? placeName?.(candidate.homePlaceId) ?? null : null);

  function assign() {
    const chosen = drivers.find((candidate) => candidate.id === driverId);
    if (!chosen) return;
    mutation.mutate({ rideId, driverId: chosen.id, expectedVersion: version, departmentId, weekStart }, {
      onSuccess: () => { setDriverId(""); toast.success(tv(published ? "rideDriver.assigned" : "rideDriver.assignedUnpublished", { name: chosen.name })); onDone?.(); },
    });
  }
  function unassign() {
    mutation.mutate({ rideId, driverId: null, expectedVersion: version, departmentId, weekStart }, {
      onSuccess: () => { toast.success(he.rideDriver.unassigned); onDone?.(); },
    });
  }

  return (
    <div className="space-y-2 rounded-md border p-3" data-testid="ride-driver-picker">
      {needsDriver ? (
        <>
          <p className="text-xs text-muted-foreground">{he.rideDriver.assignLabel}</p>
          <div className="flex items-center gap-2">
            <Select value={driverId} onValueChange={setDriverId} disabled={disabled || mutation.isPending}>
              <SelectTrigger className="min-h-11 flex-1" aria-label={he.rideDriver.selectAria} data-testid="ride-driver-select">
                <SelectValue placeholder={he.rideDriver.placeholder} />
              </SelectTrigger>
              <SelectContent>
                {drivers.map((candidate) => <SelectItem key={candidate.id} value={candidate.id}>{[candidate.name, livesAway(candidate), busyIds?.has(candidate.id) ? he.rideDriver.busy : null].filter(Boolean).join(" · ")}</SelectItem>)}
              </SelectContent>
            </Select>
            <Button type="button" className="min-h-11" disabled={!driverId || disabled || mutation.isPending} onClick={assign} data-testid="ride-driver-assign">
              {he.rideDriver.assign}
            </Button>
          </div>
        </>
      ) : (
        <div className="flex items-center justify-between gap-2">
          <p>{tv("rideDriver.current", { name: volunteerName ?? "" })}</p>
          <Button type="button" variant="outline" className="min-h-11" disabled={disabled || mutation.isPending} onClick={unassign} data-testid="ride-driver-unassign">
            {he.rideDriver.unassign}
          </Button>
        </div>
      )}
    </div>
  );
}
