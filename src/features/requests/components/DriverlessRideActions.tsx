import { useState } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { useClaimRideDriverMutation, useJoinOtherRideMutation } from "@/features/rides/hooks";
import { useDepartmentSettings } from "@/features/sadran/hooks";
import { fetchBoardRideById } from "@/features/siddur/api";
import { he, tv } from "@/i18n/he";
import { showErrorToast } from "@/lib/rpc";

import type { JoinableRideRow } from "../api";
import { useJoinableRidesMutation } from "../hooks";
import { joinableRideDriverLabel } from "../joinableRides";
import { JoinableRidesDialog } from "./JoinableRidesDialog";

interface DriverlessRideActionsProps {
  requestId: string;
  departmentId: string;
  /** The held ride the request is on (its driver cancelled; nobody left on it drives). */
  rideId: string;
  /** False for a member marked "does not drive" — no "I'll drive" then. */
  canDrive: boolean;
}

/**
 * R13M5 (QA run 13): a passenger whose driver cancelled is not left only waiting — "אני אנהג בנסיעה הזו" takes the
 * held ride's wheel (`claim_ride_driver`), "נסיעה אחרת" lists nearby rides with a free seat
 * (`joinable_rides_for_request`) and joining one moves the request's people there, releasing the held seat
 * (`join_other_ride`). Each RPC reads the ride's current version just before the call.
 */
export function DriverlessRideActions({ requestId, departmentId, rideId, canDrive }: DriverlessRideActionsProps) {
  const claim = useClaimRideDriverMutation();
  const join = useJoinOtherRideMutation();
  const joinable = useJoinableRidesMutation();
  const settings = useDepartmentSettings(departmentId);
  const [rides, setRides] = useState<JoinableRideRow[] | null>(null);
  const busy = claim.isPending || join.isPending || joinable.isPending;

  async function versionOf(id: string): Promise<number | null> {
    const ride = await fetchBoardRideById(id);
    return ride?.version ?? null;
  }

  async function drive() {
    try {
      const version = await versionOf(rideId);
      if (version == null) return;
      await claim.mutateAsync({ rideId, expectedVersion: version });
      toast.success(he.rideCoordination.volunteered);
    } catch { /* the mutation toasted its error */ }
  }

  async function findOther() {
    try {
      const found = await joinable.mutateAsync(requestId);
      if (!found.length) toast.info(he.rideCoordination.noOtherRide);
      else setRides(found);
    } catch (error) {
      showErrorToast(error);
    }
  }

  async function joinRide(targetId: string) {
    try {
      const version = await versionOf(targetId);
      if (version == null) return;
      await join.mutateAsync({ requestId, rideId: targetId, expectedVersion: version });
      const joined = rides?.find((ride) => ride.rideId === targetId);
      toast.success(tv("joinableRides.joined", { driver: joined ? joinableRideDriverLabel(joined) : "" }));
      setRides(null);
    } catch { /* the mutation toasted its error; the dialog stays open */ }
  }

  return (
    <>
      {canDrive ? (
        <Button size="sm" disabled={busy} onClick={() => void drive()} data-testid="driverless-drive">
          {he.rideCoordination.volunteer}
        </Button>
      ) : null}
      <Button size="sm" variant="outline" disabled={busy} onClick={() => void findOther()} data-testid="driverless-other-ride">
        {he.rideCoordination.findOtherRide}
      </Button>
      <JoinableRidesDialog
        open={!!rides}
        onOpenChange={(open) => { if (!open) setRides(null); }}
        rides={rides ?? []}
        radiusKm={settings.data?.join_radius_km ?? 10}
        onAskToJoin={(id) => void joinRide(id)}
        onStay={() => setRides(null)}
      />
    </>
  );
}
