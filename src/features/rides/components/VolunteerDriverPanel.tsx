import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { he } from "@/i18n/he";

import type { BoardRide } from "../api";
import { useClaimRideDriverMutation } from "../hooks";

/**
 * "חסר/ה נהג/ת" + "אני אנהג בנסיעה הזו" on a ride sheet (`claim_ride_driver`) — the siddur's and, since R13M5, `/my`'s
 * (a passenger whose driver cancelled opens the held ride from "my rides").
 */
export function VolunteerDriverPanel({ ride, onDone }: { ride: Pick<BoardRide, "id" | "version">; onDone: () => void }) {
  const claim = useClaimRideDriverMutation();
  return (
    <div className="space-y-2 rounded-md border border-destructive/50 p-3">
      <p className="font-semibold text-destructive">{he.rideCoordination.missingDriver}</p>
      <p>{he.rideCoordination.volunteerHelp}</p>
      <Button className="w-full" disabled={claim.isPending} onClick={() => {
        if (ride.id && ride.version != null) claim.mutate({ rideId: ride.id, expectedVersion: ride.version }, {
          onSuccess: () => { onDone(); toast.success(he.rideCoordination.volunteered); },
        });
      }}>{he.rideCoordination.volunteer}</Button>
    </div>
  );
}
