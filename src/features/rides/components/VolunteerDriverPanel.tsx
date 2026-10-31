import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { he } from "@/i18n/he";

import type { BoardRide } from "../api";
import { DriverWantedButton } from "./DriverWantedButton";
import { useClaimRideDriverMutation } from "../hooks";

/**
 * "חסר/ה נהג/ת" + "אני אנהג בנסיעה הזו" on a ride sheet (`claim_ride_driver`) — the siddur's and, since R13M5, `/my`'s
 * (a passenger whose driver cancelled opens the held ride from "my rides"), with "מי יכול/ה להקפיץ?" on WhatsApp (REQ §13.170).
 */
export function VolunteerDriverPanel({ ride, onDone }: { ride: BoardRide; onDone: () => void }) {
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
      {/* REQ §13.170: or ask on WhatsApp who can drive; the link opens the ride's "אני אקח" page. */}
      <DriverWantedButton ride={ride} />
    </div>
  );
}
