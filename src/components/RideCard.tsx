import { ArrowLeft, CarFront, MapPin, Star } from "lucide-react";
import { Link } from "react-router-dom";

import { paths } from "@/app/routes";

import { Card, CardContent } from "@/components/ui/card";
import { CarNameWithReport } from "@/features/carCare/components/CarNameWithReport";
import { CarGuidesChip } from "@/features/cars/guides/components/CarGuidesChip";
import type { CarHandoverNotes } from "@/features/rides/carHandover";
import { RideDeltaLine } from "@/components/RideDeltaLine";
import type { RideDeltaView } from "@/features/sadran/requestDelta";
import { CarHandoverNotice } from "@/features/rides/components/CarHandoverNotice";
import { he, tv } from "@/i18n/he";
import { formatDayDate } from "@/lib/dayLabels";
import { useRideTypeColorClasses } from "@/components/rideTypeColorsContext";
import { dateKey, formatTime } from "@/lib/time";
import { rideSpanKind } from "@/lib/wholeDay";
import { cn } from "@/lib/utils";
import type { RichLine } from "@/lib/ridePublicDetails";
import { RichLines } from "@/components/RichLines";

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
  descriptionLines?: readonly RichLine[];
  coordinatorNotes?: string;
  coordinatorNoteLines?: readonly RichLine[];
  passengerSummary?: string;
  /** REQ §13.161 (a): requested -> got, beyond flexibility only (Sadran board list mode). */
  delta?: RideDeltaView | null;
  isChauffeur?: boolean;
  needsDriver?: boolean;
  conflict?: boolean;
  isMine?: boolean;
  /** Owner 2026-10-16: "נסיעה של <name>" — a read-only ride of my child / their other guardian on `/my`; the card is muted. */
  relatedLabel?: string;
  highlighted?: boolean;
  tightSchedule?: boolean;
  carName: string | null;
  /** Owner 2026-11-17: "my rides" shows the car at the top, beside the day (a member looks for which car first). */
  carOnTop?: boolean;
  /**
   * Enables the "דיווח על רכב" icon next to `carName` (`CarNameWithReport`,
   * REQUIREMENTS §6.6). Omitted by the Sadran board's `BoardListMode` (which
   * reuses this same card shape) — by design, member self-service car
   * reporting has no place there (UX_FLOWS §3.9).
   */
  carId?: string | null;
  carType?: "shared" | "temporary";
  freeSeats?: number;
  /** `ride_types.code` — tints the icon chip to match the board/siddur grid (visual pass, `src/lib/rideTypeColors.ts`). */
  rideTypeCode?: string | null;
  /** Multi-day request leg (REQ §13.77, UX_FLOWS.md §3.3/§3.5) — 1-based position and total leg count; shows a "יום {{index}}/{{count}}" marker when `seriesCount` is above 1. */
  seriesIndex?: number | null;
  seriesCount?: number | null;
  /** REQ §13.108 f: "be back on time" note (only on the member's own ride, only when the gap is tight). */
  handover?: CarHandoverNotes;
  /** CR1 (REQ item 257): the car's open issues on `/my` (a link to the car page; needs `carId`). */
  openIssues?: number;
  /** REQ item 259: the car has "איך עושים…" guides — a chip opens them (needs `carId`). */
  hasGuides?: boolean;
  /** REQ item 248: more people than seats (already worded, `seatsShortLabel`) - a warning until someone fixes it. */
  seatsShort?: string;
}

interface RideCardProps {
  ride: RideCardData;
  onClick?: () => void;
}

/** Siddur/Home ride card: time range, origin→destination, driver, car, free seats (UX_FLOWS.md §3.3/§3.5). */
export function RideCard({ ride, onClick }: RideCardProps) {
  const rideTypeColorClasses = useRideTypeColorClasses();
  const isRelay = ride.originName !== ride.destinationName;
  const start = new Date(ride.startsAt);
  const end = ride.endsAt ? new Date(ride.endsAt) : null;
  const spanKind = rideSpanKind(ride.startsAt, ride.endsAt);
  const typeColors = rideTypeColorClasses(ride.rideTypeCode);
  const dayLabel = (date: Date) => formatDayDate(date);
  const endsOnAnotherDay = end && dateKey(start) !== dateKey(end);
  const carNameNode = ride.carName
    ? ride.carId ? <CarNameWithReport carId={ride.carId} carName={ride.carName} /> : <span>{ride.carName}</span>
    : null;

  return (
    <Card
      data-ride-id={ride.id}
      data-my-ride={ride.isMine || undefined}
      className={cn(
        "bg-gradient-card shadow-card transition-smooth",
        onClick && "cursor-pointer hover:shadow-elegant",
        ride.isMine && "shadow-md",
        ride.relatedLabel && "border-dashed opacity-75 shadow-none",
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
          {ride.showDay || (ride.carOnTop && ride.carName) ? (
            <div className="flex flex-wrap items-center justify-between gap-x-2">
              {ride.showDay ? <p className="font-bold">{dayLabel(start)}</p> : null}
              {ride.carOnTop && ride.carName ? <span className="font-medium" data-testid="ride-card-car">{carNameNode}</span> : null}
            </div>
          ) : null}
          <div className="flex items-center justify-between gap-2">
            <span dir="ltr" className={cn("tabular-nums", ride.isMine ? "font-bold" : "font-medium")}>
              {spanKind === "all_day" ? <span dir="rtl">{he.flex.anyTime}</span>
                : spanKind === "return_only" && end ? <span dir="rtl">{he.field.return} {formatTime(end)}</span>
                : spanKind === "departure_only" ? <>{formatTime(start)} →</> : <>
                  {formatTime(start)}
                  {end ? <>–{ride.showDay && endsOnAnotherDay ? <bdi>{dayLabel(end)} </bdi> : null}{formatTime(end)}</> : " →"}
                </>}
            </span>
            {ride.carType === "temporary" ? (
              <span className="flex items-center gap-1 rounded-full bg-booked/10 px-2 py-0.5 text-xs font-medium text-booked">
                <CarFront className="size-3" aria-hidden="true" />
                {he.car.type.temporary}
              </span>
            ) : null}
          </div>

          {ride.relatedLabel ? <span className="flex items-center gap-1 text-xs font-medium text-muted-foreground" data-testid="related-ride-label">{ride.relatedLabel}</span> : null}
          {ride.isMine ? <span className={cn("flex items-center gap-1 text-xs font-bold", ride.needsDriver ? "text-destructive" : "text-primary")}><Star className="size-3 fill-current" aria-hidden="true" /><span className="sr-only">{he.siddur.myRide}</span></span> : null}
          {ride.seriesCount && ride.seriesCount > 1 ? (
            <span className="text-xs text-muted-foreground">
              {tv("ride.seriesDay", { index: String(ride.seriesIndex ?? 1), count: String(ride.seriesCount) })}
            </span>
          ) : null}
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
          <RideDeltaLine view={ride.delta} className="text-xs" />
          {ride.description ? <p className="whitespace-pre-wrap break-words text-muted-foreground">{ride.descriptionLines ? <RichLines lines={ride.descriptionLines} /> : ride.description}</p> : null}
          {ride.handover ? <CarHandoverNotice notes={ride.handover} ride={{ startsAt: ride.startsAt, endsAt: ride.endsAt ?? ride.startsAt }} /> : null}
          {ride.coordinatorNotes ? <p className="whitespace-pre-wrap break-words text-xs text-muted-foreground">{he.field.notes}: {ride.coordinatorNoteLines ? <RichLines lines={ride.coordinatorNoteLines} /> : ride.coordinatorNotes}</p> : null}
          <div className="flex flex-wrap items-center gap-x-2 text-muted-foreground">
            {ride.needsDriver ? <span className="font-semibold text-destructive">{he.rideCoordination.missingDriver}</span> : null}
            {ride.conflict ? <span className="font-semibold text-destructive">{he.board.conflicts}</span> : null}
            {ride.seatsShort ? (
              <span className="rounded bg-amber-100 px-1 font-medium text-amber-950 dark:bg-amber-900/40 dark:text-amber-100" data-testid="ride-seats-short">
                {ride.seatsShort}
              </span>
            ) : null}
            {ride.openIssues && ride.carId ? (
              <Link
                to={paths.car(ride.carId)}
                className="rounded bg-maintenance/15 px-1 font-medium text-maintenance hover:underline"
                onClick={(event) => event.stopPropagation()}
                onKeyDown={(event) => event.stopPropagation()}
                data-testid="ride-open-issues"
              >
                {ride.openIssues === 1 ? he.carPage.rideOpenIssuesOne : tv("carPage.rideOpenIssuesMany", { count: String(ride.openIssues) })}
              </Link>
            ) : null}
            {ride.hasGuides && ride.carId ? <CarGuidesChip carId={ride.carId} /> : null}
            {ride.tightSchedule ? <span role="img" aria-label={he.rideCoordination.tightSchedule} title={he.rideCoordination.tightSchedule}>⏱</span> : null}
            {ride.carName && !ride.carOnTop ? carNameNode : null}
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
