import { ArrowLeft, CarFront, MapPin } from "lucide-react";

import { Card, CardContent } from "@/components/ui/card";
import { he } from "@/i18n/he";
import { formatTime } from "@/lib/time";
import { cn } from "@/lib/utils";

/**
 * Decoupled from any single generated view/table — `v_board_rides` has no
 * car name/type and `v_my_requests` has no requester id (see
 * src/features/requests/api.ts for why Home queries `requests` directly).
 * Callers map whichever row they have onto this shape.
 */
export interface RideCardData {
  id: string;
  startsAt: string;
  /** `null` for a one-way leg that only has a departure or an arrival. */
  endsAt: string | null;
  originName: string;
  destinationName: string;
  driverName: string | null;
  isChauffeur?: boolean;
  carName: string | null;
  carType?: "shared" | "temporary";
  freeSeats?: number;
}

interface RideCardProps {
  ride: RideCardData;
  onClick?: () => void;
}

/** Siddur/Home ride card: time range, origin→destination, driver, car, free seats (UX_FLOWS.md §3.3/§3.5). */
export function RideCard({ ride, onClick }: RideCardProps) {
  const isRelay = ride.originName !== ride.destinationName;
  const start = new Date(ride.startsAt);
  const end = ride.endsAt ? new Date(ride.endsAt) : null;

  return (
    <Card
      className={cn("transition-colors", onClick && "cursor-pointer hover:bg-accent/40")}
      onClick={onClick}
      role={onClick ? "button" : undefined}
      tabIndex={onClick ? 0 : undefined}
    >
      <CardContent className="space-y-1.5 p-4 text-sm">
        <div className="flex items-center justify-between gap-2">
          <span dir="ltr" className="font-medium tabular-nums">
            {formatTime(start)}
            {end ? `–${formatTime(end)}` : " →"}
          </span>
          {ride.carType === "temporary" ? (
            <span className="flex items-center gap-1 rounded-full bg-sky-100 px-2 py-0.5 text-xs text-sky-900">
              <CarFront className="size-3" aria-hidden="true" />
              {he.car.type.temporary}
            </span>
          ) : null}
        </div>

        <div className="flex items-center gap-1 font-medium">
          {isRelay ? (
            <span className="flex items-center gap-1">
              <MapPin className="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
              {ride.originName}
              <ArrowLeft className="size-3.5 shrink-0 rtl:-scale-x-100" aria-hidden="true" />
              {ride.destinationName}
            </span>
          ) : (
            <span className="flex items-center gap-1">
              <MapPin className="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
              {ride.destinationName}
            </span>
          )}
        </div>

        <div className="flex flex-wrap items-center gap-x-2 text-muted-foreground">
          {ride.carName ? <span>{ride.carName}</span> : null}
          {ride.driverName ? (
            <span>
              {ride.isChauffeur ? he.ride.chauffeur : he.ride.driver}: {ride.driverName}
            </span>
          ) : null}
          {typeof ride.freeSeats === "number" ? (
            <span dir="ltr">{ride.freeSeats}</span>
          ) : null}
        </div>
      </CardContent>
    </Card>
  );
}
