import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { he, tv } from "@/i18n/he";
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
 * — never a phone number (REQ §10); "talk to them" is the ask-to-join request itself, answered
 * by the driver like any other.
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
              <Button type="button" size="sm" onClick={() => onAskToJoin(ride.rideId)}>
                {he.joinableRides.askToJoin}
              </Button>
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
