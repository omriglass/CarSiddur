import { ArrowLeft, CarFront, MapPin } from "lucide-react";

import { Card, CardContent } from "@/components/ui/card";
import { he } from "@/i18n/he";
import { rideTypeColorClasses } from "@/lib/rideTypeColors";
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
  /** `ride_types.code` — tints the icon chip to match the board/siddur grid (visual pass, `src/lib/rideTypeColors.ts`). */
  rideTypeCode?: string | null;
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
  const typeColors = rideTypeColorClasses(ride.rideTypeCode);

  return (
    <Card
      className={cn(
        "bg-gradient-card shadow-card transition-smooth",
        onClick && "cursor-pointer hover:shadow-elegant",
      )}
      onClick={onClick}
      role={onClick ? "button" : undefined}
      tabIndex={onClick ? 0 : undefined}
    >
      <CardContent className="flex gap-3 p-4 text-sm">
        <span className={cn("flex size-9 shrink-0 items-center justify-center rounded-lg", typeColors.bg, typeColors.text)}>
          <CarFront className="size-5" aria-hidden="true" />
        </span>
        <div className="min-w-0 flex-1 space-y-1.5">
          <div className="flex items-center justify-between gap-2">
            <span dir="ltr" className="font-medium tabular-nums">
              {formatTime(start)}
              {end ? `–${formatTime(end)}` : " →"}
            </span>
            {ride.carType === "temporary" ? (
              <span className="flex items-center gap-1 rounded-full bg-booked/10 px-2 py-0.5 text-xs font-medium text-booked">
                <CarFront className="size-3" aria-hidden="true" />
                {he.car.type.temporary}
              </span>
            ) : null}
          </div>

          <div className="flex items-center gap-1 font-medium">
            {isRelay ? (
              <span className="flex min-w-0 items-center gap-1">
                <MapPin className="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
                <span className="truncate">{ride.originName}</span>
                <ArrowLeft className="size-3.5 shrink-0 rtl:-scale-x-100" aria-hidden="true" />
                <span className="truncate">{ride.destinationName}</span>
              </span>
            ) : (
              <span className="flex min-w-0 items-center gap-1">
                <MapPin className="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
                <span className="truncate">{ride.destinationName}</span>
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
        </div>
      </CardContent>
    </Card>
  );
}
