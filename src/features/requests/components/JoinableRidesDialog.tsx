import { MessageCircle } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { buildWaUrl } from "@/features/sadran/proposals/waLink";
import { he, tv } from "@/i18n/he";
import { weekdayLabel } from "@/lib/dayLabels";
import { formatTime } from "@/lib/time";

import type { JoinableRideRow } from "../api";
import { joinableRideDriverLabel } from "../joinableRides";

export interface JoinableRidesDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  rides: readonly JoinableRideRow[];
  /** `department_settings.join_radius_km` for the toast/dialog body's "{{radius}}". */
  radiusKm: number;
  onAskToJoin: (rideId: string) => void;
  /** "להישאר ברשימת ההמתנה" — continues whatever navigation the waiting-list outcome itself would have done. */
  onStay: () => void;
}

/**
 * F4 (docs/TODO.md, owner answers A8-A10, 2026-09-14): shown right after a `waitlisted` submit
 * outcome (published/live week only), before `RequestForm.performSubmit` navigates away —
 * "you are on the waiting list, HOWEVER here is another option instead of just waiting". Each
 * row is an existing ride the same day, going somewhere close (`joinable_rides_for_request`),
 * with a one-tap "ask to join" (the existing `join_ride_id` flow, `paths.requests.new({ ride })`)
 * — that request is still the only thing that actually seats you, answered by the driver like
 * any other. On top of it, a WhatsApp icon button opens a prefilled `wa.me` chat to the driver
 * directly (owner amendment 2026-09-14, REQ §10/§13.83: department members' phone numbers are
 * not treated as secrets); hidden when `driver_phone` is null (no phone on file, or the ride
 * has no driver yet).
 */
export function JoinableRidesDialog({ open, onOpenChange, rides, radiusKm, onAskToJoin, onStay }: JoinableRidesDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{he.joinableRides.title}</DialogTitle>
          <DialogDescription>{tv("joinableRides.body", { radius: String(radiusKm) })}</DialogDescription>
        </DialogHeader>
        <ul className="flex flex-col gap-3">
          {rides.map((ride) => (
            <li key={ride.rideId} className="flex items-center justify-between gap-3 rounded-md border p-3">
              <div className="flex flex-col gap-0.5 text-sm">
                <span>
                  <span dir="ltr">{formatTime(new Date(ride.startsAt))}–{formatTime(new Date(ride.endsAt))}</span>
                  {" "}· {ride.destinationName}
                </span>
                <span className="text-muted-foreground">
                  {joinableRideDriverLabel(ride)} · {tv("joinableRides.distance", { km: String(ride.distanceKm) })} ·{" "}
                  {tv("siddur.freeSeats", { count: String(ride.freeSeats) })}
                </span>
              </div>
              <div className="flex items-center gap-2">
                {ride.driverPhone ? (
                  <Button asChild type="button" variant="outline" size="icon" aria-label={he.joinableRides.whatsapp}>
                    <a
                      href={buildWaUrl(
                        ride.driverPhone,
                        tv("joinableRides.whatsappText", {
                          driver: joinableRideDriverLabel(ride),
                          destination: ride.destinationName,
                          day: weekdayLabel(ride.startsAt),
                          time: formatTime(new Date(ride.startsAt)),
                        }),
                      )}
                      target="_blank"
                      rel="noopener"
                    >
                      <MessageCircle className="size-4" />
                    </a>
                  </Button>
                ) : null}
                <Button type="button" size="sm" onClick={() => onAskToJoin(ride.rideId)}>
                  {he.joinableRides.askToJoin}
                </Button>
              </div>
            </li>
          ))}
        </ul>
        <DialogFooter>
          <Button type="button" variant="outline" className="w-full sm:w-auto" onClick={onStay}>
            {he.joinableRides.stay}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
