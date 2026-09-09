import { ArrowLeft, CarFront, MapPin, Star } from "lucide-react";
import { formatInTimeZone } from "date-fns-tz";

import { Card, CardContent } from "@/components/ui/card";
import { he } from "@/i18n/he";
import { weekdayLabel } from "@/lib/dayLabels";
import { rideTypeColorClasses } from "@/lib/rideTypeColors";
import { dateKey, formatTime, TZ } from "@/lib/time";
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
  label?: string;
  showDay?: boolean;
  purpose?: string;
  joining?: string[];
  driverName: string | null;
  description?: string;
  coordinatorNotes?: string;
  passengerSummary?: string;
  isChauffeur?: boolean;
  needsDriver?: boolean;
  conflict?: boolean;
  isMine?: boolean;
  highlighted?: boolean;
  tightSchedule?: boolean;
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
  const dayLabel = (date: Date) => `${weekdayLabel(date)} · ${formatInTimeZone(date, TZ, "d/M/yyyy")}`;
  const endsOnAnotherDay = end && dateKey(start) !== dateKey(end);

  return (
    <Card
      data-ride-id={ride.id}
      data-my-ride={ride.isMine || undefined}
      className={cn(
        "bg-gradient-card shadow-card transition-smooth",
        onClick && "cursor-pointer hover:shadow-elegant",
        ride.isMine && "shadow-md",
        ride.isMine && !ride.needsDriver && "ring-2 ring-primary/60",
        ride.needsDriver && "border-2 border-dashed border-destructive bg-destructive/5",
        ride.conflict && "border-destructive bg-destructive/5",
        ride.highlighted && "scroll-mt-24 ring-4 ring-destructive ring-offset-2",
      )}
      onClick={onClick}
      role={onClick ? "button" : undefined}
      tabIndex={onClick ? 0 : undefined}
      onKeyDown={onClick ? (event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); onClick(); } } : undefined}
    >
      <CardContent className="flex gap-3 p-4 text-sm">
        <span className={cn("flex size-9 shrink-0 items-center justify-center rounded-lg", typeColors.bg, typeColors.text)}>
          <CarFront className="size-5" aria-hidden="true" />
        </span>
        <div className="min-w-0 flex-1 space-y-1.5">
          {ride.showDay ? <p className="font-bold">{dayLabel(start)}</p> : null}
          <div className="flex items-center justify-between gap-2">
            <span dir="ltr" className={cn("tabular-nums", ride.isMine ? "font-bold" : "font-medium")}>
              {formatTime(start)}
              {end ? <>–{ride.showDay && endsOnAnotherDay ? <bdi>{dayLabel(end)} </bdi> : null}{formatTime(end)}</> : " →"}
            </span>
            {ride.carType === "temporary" ? (
              <span className="flex items-center gap-1 rounded-full bg-booked/10 px-2 py-0.5 text-xs font-medium text-booked">
                <CarFront className="size-3" aria-hidden="true" />
                {he.car.type.temporary}
              </span>
            ) : null}
          </div>

          {ride.isMine ? <span className={cn("flex items-center gap-1 text-xs font-bold", ride.needsDriver ? "text-destructive" : "text-primary")}><Star className="size-3 fill-current" aria-hidden="true" />{he.siddur.myRide}</span> : null}
          <div className={cn("flex items-center gap-1", ride.isMine ? "font-bold" : "font-medium")}>
            {ride.label ? (
              <span className="flex min-w-0 items-center gap-1">
                <MapPin className="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
                <span>{ride.label}</span>
              </span>
            ) : isRelay ? (
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

          {ride.purpose ? <p className="text-sm text-muted-foreground">({ride.purpose})</p> : null}
          {ride.joining?.map((line, index) => <p key={index} className="whitespace-normal break-words text-sm">{line}</p>)}
          {ride.passengerSummary ? <p className="whitespace-pre-wrap break-words">{ride.passengerSummary}</p> : null}
          {ride.description ? <p className="whitespace-pre-wrap break-words text-muted-foreground">{ride.description}</p> : null}
          {ride.coordinatorNotes ? <p className="whitespace-pre-wrap break-words text-xs text-muted-foreground">{he.field.notes}: {ride.coordinatorNotes}</p> : null}
          <div className="flex flex-wrap items-center gap-x-2 text-muted-foreground">
            {ride.needsDriver ? <span className="font-semibold text-destructive">{he.rideCoordination.missingDriver}</span> : null}
            {ride.conflict ? <span className="font-semibold text-destructive">{he.board.conflicts}</span> : null}
            {ride.tightSchedule ? <span role="img" aria-label={he.rideCoordination.tightSchedule} title={he.rideCoordination.tightSchedule}>⏱</span> : null}
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
