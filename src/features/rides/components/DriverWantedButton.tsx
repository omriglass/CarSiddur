import { MessageCircle } from "lucide-react";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import { useSession } from "@/features/auth/useSession";
import { paths } from "@/app/routes";
import { he } from "@/i18n/he";

import type { BoardRide } from "../api";
import { driverWantedText } from "../driverWanted";

/** REQ §13.170: opens WhatsApp (pick a chat or a group) asking who can drive this ride, with a link to its "אני אקח" page. */
export function DriverWantedButton({ ride }: { ride: BoardRide }) {
  const viewerId = useSession().session?.user.id;
  const [shownAt] = useState(() => Date.now());
  if (!ride.id || !ride.needs_driver || ride.status === "cancelled" || (ride.ends_at && Date.parse(ride.ends_at) <= shownAt)) return null;
  const rideId = ride.id;
  return (
    <Button type="button" className="w-full" size="lg" variant="outline" data-testid="driver-wanted-whatsapp"
      onClick={() => {
        const text = driverWantedText(ride, viewerId, new Date(), `${window.location.origin}${paths.ride(rideId)}`);
        window.open(`https://wa.me/?text=${encodeURIComponent(text)}`, "_blank", "noopener");
      }}>
      <MessageCircle className="size-4" />
      {he.driverWanted.button}
    </Button>
  );
}
