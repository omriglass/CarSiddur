import { ArrowLeft, MapPin } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { he, t, tv } from "@/i18n/he";
import { formatTime } from "@/lib/time";
import type { Car } from "@/features/fleet/api";

import type { BoardRide } from "../api";

interface ServedEntry {
  request_id: string | null;
  role: "driver" | "passenger";
  car_mode: "keep" | "relay" | "passenger" | "chauffeur";
  requester: string | null;
  destination: string | null;
  ride_type: string | null;
  adults: number;
  child_seats: number;
  boosters: number;
}

function carModeLabel(ride: BoardRide): string {
  if (ride.origin_id === ride.destination_id) {
    return ride.is_chauffeur ? he.rideDetail.carModeChauffeur : he.rideDetail.carModeKeep;
  }
  return tv("rideDetail.carModeRelayOut", { destination: ride.destination_name ?? "" });
}

interface RideDetailSheetProps {
  ride: BoardRide | null;
  car: Car | null;
  locationBadge: string | null;
  onOpenChange: (open: boolean) => void;
  onAskToJoin: () => void;
  /** Own rides don't show "ask to join"; other-department rides never do (REQ §13.52). */
  showAskToJoin: boolean;
}

/** Ride detail sheet (UX_FLOWS.md §3.5 "Ride detail"): driver, passengers, car, origin→destination, "ask to join". */
export function RideDetailSheet({ ride, car, locationBadge, onOpenChange, onAskToJoin, showAskToJoin }: RideDetailSheetProps) {
  const served = (ride?.served as unknown as ServedEntry[] | null) ?? [];

  return (
    <Sheet open={!!ride} onOpenChange={onOpenChange}>
      <SheetContent side="bottom" className="max-h-[85dvh] overflow-y-auto">
        {ride ? (
          <>
            <SheetHeader>
              <SheetTitle>{t("rideDetail.title")}</SheetTitle>
            </SheetHeader>
            <div className="space-y-4 py-4 text-sm">
              <div className="flex items-center justify-between gap-2">
                <span dir="ltr" className="font-medium tabular-nums">
                  {formatTime(new Date(ride.starts_at ?? ""))}
                  {ride.ends_at ? `–${formatTime(new Date(ride.ends_at))}` : " →"}
                </span>
                {locationBadge ? (
                  <span className="rounded-full bg-muted px-2 py-0.5 text-xs text-muted-foreground">
                    {tv("rideDetail.locationBadge", { location: locationBadge })}
                  </span>
                ) : null}
              </div>

              <div className="flex items-center gap-1 font-medium">
                <MapPin className="size-4 shrink-0 text-muted-foreground" />
                {ride.origin_id !== ride.destination_id ? (
                  <span className="flex items-center gap-1">
                    {ride.origin_name}
                    <ArrowLeft className="size-3.5 shrink-0 rtl:-scale-x-100" />
                    {ride.destination_name}
                  </span>
                ) : (
                  <span>{ride.destination_name}</span>
                )}
              </div>

              <p className="text-muted-foreground">{carModeLabel(ride)}</p>

              <div className="space-y-1">
                <span className="font-medium">
                  {ride.is_chauffeur ? he.rideDetail.chauffeur : he.rideDetail.driver}
                </span>
                <p>{ride.driver_name}</p>
              </div>

              {car ? (
                <div className="space-y-1">
                  <span className="font-medium">{he.rideDetail.car}</span>
                  <p>
                    {car.name}
                    {car.type === "temporary" ? ` · ${he.car.type.temporary}` : ""}
                  </p>
                </div>
              ) : null}

              {served.length > 0 ? (
                <div className="space-y-1">
                  <span className="font-medium">{he.rideDetail.passengers}</span>
                  <ul className="space-y-0.5">
                    {served.map((entry, i) => (
                      <li key={entry.request_id ?? i}>
                        {entry.requester} — {entry.role === "driver" ? he.ride.driver : he.rideDetail.passengers}
                      </li>
                    ))}
                  </ul>
                </div>
              ) : null}

              {showAskToJoin ? (
                <Button className="w-full" size="lg" onClick={onAskToJoin}>
                  {t("rideDetail.askToJoin")}
                </Button>
              ) : null}
            </div>
          </>
        ) : null}
      </SheetContent>
    </Sheet>
  );
}
