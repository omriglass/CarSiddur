import { useState } from "react";

import { ConfirmDialog } from "@/components/ConfirmDialog";
import { Button } from "@/components/ui/button";
import { useDepartmentMembers } from "@/features/auth/useDepartmentMembers";
import { he, tv } from "@/i18n/he";

import type { BoardRide } from "../api";
import { mergedLeaveOptions } from "../handOver";
import { peopleOf } from "../ridePeople";
import { useLeaveMergedRideMutation } from "../hooks";
import { useLeaveNoDriver } from "../useLeaveNoDriver";

/**
 * REQ item 229, the Sadran's side (board ride sheet): take the driver off a merged ride — another person on it drives,
 * or nobody (the ride waits for a driver). The driver's own request is withdrawn; the car stays. With nobody driving,
 * R20B15: when the riders left need fewer hours, "לקצר את הנסיעה?" replaces the confirmation (`useLeaveNoDriver`).
 */
export function LeaveMergedRideActions({ ride, onDone }: { ride: BoardRide; onDone: () => void }) {
  const membersQuery = useDepartmentMembers(ride.department_id ?? undefined, { includeSelf: true });
  const mutation = useLeaveMergedRideMutation();
  const leaveNoDriver = useLeaveNoDriver();
  const [pick, setPick] = useState<{ id: string | null; label: string } | null>(null);
  const options = mergedLeaveOptions(ride, ride.driver_id, membersQuery.data ?? []);
  if (!options || !ride.id || ride.version == null || !ride.department_id || !ride.week_start) return null;
  const { id, version, department_id, week_start } = ride;
  const driverName = peopleOf(ride).find((p) => p.source === "driver")?.display_name ?? "";

  return (
    <div className="space-y-2" data-testid="leave-merged-ride">
      <p className="text-sm font-medium">{tv("rideDetail.removeDriverTitle", { name: driverName })}</p>
      {options.candidates.map((option) => (
        <Button key={option.id} variant="outline" className="w-full" disabled={mutation.isPending || leaveNoDriver.busy} data-testid="remove-driver-option"
          onClick={() => void leaveNoDriver.start(ride, driverName, onDone, tv("rideDetail.removeDriverConfirm", { name: driverName }),
            () => setPick({ id: option.id, label: tv("rideDetail.removeDriverOption", { name: option.name }) }), { id: option.id, name: option.name })}>
          {tv("rideDetail.removeDriverOption", { name: option.name })}
        </Button>
      ))}
      {options.noDriver ? (
        <Button variant="outline" className="w-full" disabled={mutation.isPending || leaveNoDriver.busy} data-testid="remove-driver-none"
          onClick={() => void leaveNoDriver.start(ride, driverName, onDone, tv("rideDetail.removeDriverConfirm", { name: driverName }),
            () => setPick({ id: null, label: he.rideDetail.removeDriverNone }))}>
          {he.rideDetail.removeDriverNone}
        </Button>
      ) : null}
      <p className="text-xs text-muted-foreground">{he.rideDetail.removeDriverHelp}</p>
      <ConfirmDialog
        open={!!pick}
        onOpenChange={(open) => { if (!open) setPick(null); }}
        title={pick?.label ?? ""}
        description={tv("rideDetail.removeDriverConfirm", { name: driverName })}
        confirmLabel={he.rideDetail.removeDriverConfirmButton}
        loading={mutation.isPending}
        onConfirm={() => {
          if (!pick) return;
          mutation.mutate({ rideId: id, expectedVersion: version, newDriver: pick.id, departmentId: department_id, weekStart: week_start },
            { onSuccess: () => { setPick(null); onDone(); } });
        }}
      />
      {leaveNoDriver.dialog}
    </div>
  );
}
