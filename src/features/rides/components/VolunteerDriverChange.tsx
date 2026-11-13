import { useState } from "react";
import { toast } from "sonner";

import { ConfirmDialog } from "@/components/ConfirmDialog";
import { Button } from "@/components/ui/button";
import { useDepartmentMembers } from "@/features/auth/useDepartmentMembers";
import { he, tv } from "@/i18n/he";

import type { BoardRide } from "../api";
import { volunteerDriverOf } from "../driverWanted";
import { mergedLeaveOptions } from "../handOver";
import { useLeaveMergedRideMutation, useVolunteerDriverChangeMutation } from "../hooks";

/**
 * REQ §13.174: on a ride a volunteer drives, the volunteer gets "אני לא יכול/ה לנהוג" ("the ride will be left without
 * a driver — sure?") and any other member who can drive gets "אני אנהג" ("X already volunteered — take it from them?").
 * Renders nothing on any other ride, or once the ride has started.
 */
export function VolunteerDriverChange({ ride, viewerId, canDrive, now, onDone }: {
  ride: BoardRide; viewerId: string | undefined; canDrive: boolean; now: number; onDone?: () => void;
}) {
  const change = useVolunteerDriverChangeMutation();
  const leave = useLeaveMergedRideMutation();
  const [confirm, setConfirm] = useState(false);
  const volunteer = volunteerDriverOf(ride);
  const mineVolunteer = !!volunteer && volunteer.id === viewerId;
  // Q5 (owner 2026-11-14): the volunteer may hand the wheel to someone riding along (never on a הקפצה)
  const membersQuery = useDepartmentMembers(mineVolunteer ? ride.department_id ?? undefined : undefined, { includeSelf: true });
  const handTo = mineVolunteer ? mergedLeaveOptions(ride, viewerId, membersQuery.data ?? [])?.candidates ?? [] : [];
  if (!volunteer || !viewerId || !ride.id || ride.version == null || !ride.starts_at || Date.parse(ride.starts_at) <= now) return null;
  const mine = volunteer.id === viewerId;
  if (!mine && !canDrive) return null;
  const { id, version } = ride;
  const run = () => change.mutate({ rideId: id, expectedVersion: version, action: mine ? "release" : "takeOver" }, {
    onSuccess: () => { setConfirm(false); toast.success(mine ? he.rideCoordination.steppedDown : he.rideCoordination.tookOver); onDone?.(); },
  });
  return (
    <div className="space-y-2 rounded-md border p-3" data-testid="volunteer-driver-change">
      <p>{mine ? he.rideCoordination.youVolunteered : tv("rideCoordination.volunteerDrives", { name: volunteer.name })}</p>
      <Button className="w-full" variant={mine ? "outline" : "default"} disabled={change.isPending} onClick={() => setConfirm(true)}
        data-testid={mine ? "volunteer-step-down" : "volunteer-take-over"}>
        {mine ? he.rideCoordination.stepDown : he.rideCoordination.takeOver}
      </Button>
      <ConfirmDialog
        open={confirm}
        onOpenChange={setConfirm}
        title={mine ? he.rideCoordination.stepDownTitle : tv("rideCoordination.takeOverTitle", { name: volunteer.name })}
        description={mine ? he.rideCoordination.stepDownBody : tv("rideCoordination.takeOverBody", { name: volunteer.name })}
        confirmLabel={mine ? he.rideCoordination.stepDownConfirm : he.rideCoordination.takeOverConfirm}
        destructive={mine}
        loading={change.isPending}
        onConfirm={run}
      >
        {handTo.length && ride.department_id && ride.week_start ? (
          <div className="space-y-2" data-testid="volunteer-hand-over">
            {handTo.map((option) => (
              <Button key={option.id} variant="outline" className="w-full" disabled={leave.isPending || change.isPending}
                data-testid="volunteer-hand-over-option"
                onClick={() => leave.mutate({ rideId: id, expectedVersion: version, newDriver: option.id,
                  departmentId: ride.department_id as string, weekStart: ride.week_start as string },
                  { onSuccess: () => { setConfirm(false); toast.success(he.rideCoordination.steppedDown); onDone?.(); } })}>
                {tv("rideDetail.removeDriverOption", { name: option.name })}
              </Button>
            ))}
          </div>
        ) : null}
      </ConfirmDialog>
    </div>
  );
}
