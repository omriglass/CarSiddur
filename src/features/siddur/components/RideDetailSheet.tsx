import { MapPin } from "lucide-react";
import type { ReactNode } from "react";

import { Button } from "@/components/ui/button";
import { Sheet, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { PortalSheetContent } from "@/components/PortalSheetContent";
import { CarNameWithReport } from "@/features/carCare/components/CarNameWithReport";
import { rideBlockLabel } from "@/lib/rideLabel";
import { siddurCarName } from "@/lib/siddurCarName";
import { ridePublicDetails } from "@/lib/ridePublicDetails";
import { he, t, tv } from "@/i18n/he";
import { formatTime } from "@/lib/time";
import type { Car } from "@/features/fleet/api";
import { servedOf, type ServedEntry } from "@/features/sadran/servedOf";

import type { BoardRide } from "../api";
import { AddPassengersDialog } from "./AddPassengersDialog";
import { RidePassengersList } from "./RidePassengersList";
import { RidePublicNotesEditor } from "./RidePublicNotesEditor";
import { peopleOf } from "../ridePeople";

/**
 * "<driver> ו<passengers> ל/מ<real destination>" (UX_FLOWS.md §20 — the
 * same "shows the department's own name instead of the real destination"
 * bug the Sadran board fixed for round trips, `rideBlockLabel`/
 * DATA_MODEL.md consistency decision #14) — falls back to the ride's own
 * origin/destination names (pre-fix behavior) when `homeDestinationId` isn't
 * known yet (still loading).
 */
function headerLabel(ride: BoardRide, served: readonly ServedEntry[], homeDestinationId: string | null): string {
  if (!homeDestinationId || !ride.origin_id || !ride.destination_id) {
    return ride.origin_id !== ride.destination_id
      ? `${ride.origin_name} → ${ride.destination_name}`
      : (ride.destination_name ?? "");
  }
  return rideBlockLabel({
    originId: ride.origin_id,
    destinationId: ride.destination_id,
    originName: ride.origin_name ?? "",
    destinationName: ride.destination_name ?? "",
    homeDestinationId,
    served,
    driverName: ride.driver_name,
    isChauffeur: !!ride.is_chauffeur,
    needsDriver: !!ride.needs_driver,
  });
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
  /** The department's home location — for composing the real destination on a round trip (bug fix, see `headerLabel` above). */
  homeDestinationId?: string | null;
  onOpenChange: (open: boolean) => void;
  editor?: ReactNode;
  coordinatorNotes?: string;
  canEditPublicNotes?: boolean;
  passengerSummary?: string;
  /** Available only when the signed-in member has a request served by this ride. */
  onRemoveOwnRide?: () => void;
  removingOwnRide?: boolean;
  /**
   * The "+ נוסעים" button and the unified people list's remove (×) affordance (REQ §13.85):
   * true once the ride's week is public (or the caller manages it) and the ride itself isn't
   * cancelled — the caller already tracks week phase for `canEditWeek`, so it computes this
   * instead of this sheet guessing at week state. Also gates `RidePassengersList`'s removal —
   * same authorization `add_ride_passengers()`/`remove_ride_person()` share.
   */
  showAddPassengers?: boolean;
}

/**
 * Ride detail sheet (UX_FLOWS.md §3.5 "Ride detail"): one unified people list (driver first,
 * then everyone else, each removable per `remove_ride_person()`'s own rules), car,
 * origin→destination. Owner decision 2026-09-14: on a published week "+ נוסעים" is the way to
 * join a ride — there is no separate "ask to join" button here any more (superseded, REQ
 * §13.85; the `/requests/new?ride=` prefill path itself is untouched, still reachable from the
 * joinable-rides dialog after a waiting-list outcome).
 */
export function RideDetailSheet({ ride, car, locationBadge, homeDestinationId = null, onOpenChange, editor, coordinatorNotes, canEditPublicNotes, passengerSummary, onRemoveOwnRide, removingOwnRide = false, showAddPassengers = false }: RideDetailSheetProps) {
  // `servedOf()` already maps `v_board_rides.served[].child_names` onto each entry's
  // `childNames` (`applySolve.ts`) — no more hand-rolled mapping needed here.
  const served: ServedEntry[] = ride ? servedOf(ride) : [];
  // Directly `add_ride_passengers()`-added names (`people`, `source: 'added'`) — not tied to
  // any served request, so `ridePublicDetails` takes them as a trailing line of their own.
  const addedNames: string[] = ride ? peopleOf(ride).filter((person) => person.source === "added").map((person) => person.display_name) : [];

  return (
    <Sheet open={!!ride} onOpenChange={onOpenChange}>
      <PortalSheetContent side="bottom" className="max-h-[85dvh] overflow-y-auto">
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
                <span>{headerLabel(ride, served, homeDestinationId)}</span>
              </div>

              {ride.series_count && ride.series_count > 1 ? (
                <p className="text-sm text-muted-foreground">
                  {tv("rideDetail.seriesLine", { index: String(ride.series_index ?? 1), count: String(ride.series_count) })}
                </p>
              ) : null}

              <p className="text-muted-foreground">{carModeLabel(ride)}</p>
              {canEditPublicNotes && ride.id && ride.version != null ? (
                <RidePublicNotesEditor key={`${ride.id}:${ride.version}`} rideId={ride.id} expectedVersion={ride.version} initialNotes={ride.notes} />
              ) : ride.notes ? <p className="whitespace-pre-wrap break-words">{ride.notes}</p> : null}
              {passengerSummary ? <p className="whitespace-pre-wrap break-words">{passengerSummary}</p> : null}
              {ridePublicDetails(served, { includeCompanions: !passengerSummary, addedNames }) ? <p className="whitespace-pre-wrap break-words">{ridePublicDetails(served, { includeCompanions: !passengerSummary, addedNames })}</p> : null}
              {coordinatorNotes ? <div className="whitespace-pre-wrap break-words text-muted-foreground"><span className="font-medium">{he.field.notes}: </span>{coordinatorNotes}</div> : null}
              {editor}

              <div className="space-y-1">
                <span className="font-medium">
                  {ride.is_chauffeur ? he.rideDetail.chauffeur : he.rideDetail.driver}
                </span>
                <p className={ride.needs_driver ? "font-semibold text-destructive" : undefined}>{ride.needs_driver ? he.rideCoordination.missingDriver : ride.driver_name}</p>
              </div>

              {car ? (
                <div className="space-y-1">
                  <span className="font-medium">{he.rideDetail.car}</span>
                  <p>
                    <CarNameWithReport carId={car.id} carName={siddurCarName(car)} />
                    {car.type === "temporary" ? ` · ${he.car.type.temporary}` : ""}
                  </p>
                </div>
              ) : null}

              <RidePassengersList
                rideId={ride.id}
                expectedVersion={ride.version}
                people={peopleOf(ride)}
                canManagePeople={showAddPassengers}
                rideCancelled={ride.status === "cancelled"}
              />

              {showAddPassengers && ride.id && ride.version != null ? (
                <AddPassengersDialog
                  key={`${ride.id}:${ride.version}:add-passengers`}
                  rideId={ride.id}
                  expectedVersion={ride.version}
                  departmentId={ride.department_id ?? ""}
                  weekStart={ride.week_start ?? ""}
                  people={peopleOf(ride)}
                />
              ) : null}

              {onRemoveOwnRide ? (
                <Button className="w-full" size="lg" variant="destructive" disabled={removingOwnRide} onClick={onRemoveOwnRide}>
                  {t("action.cancelRide")}
                </Button>
              ) : null}
            </div>
          </>
        ) : null}
      </PortalSheetContent>
    </Sheet>
  );
}
