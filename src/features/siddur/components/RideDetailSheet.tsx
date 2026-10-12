import { Car as CarIcon, MapPin } from "lucide-react";
import { useState, type ReactNode } from "react";
import { Link } from "react-router-dom";

import { Button } from "@/components/ui/button";
import { Sheet, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { PortalSheetContent } from "@/components/PortalSheetContent";
import { CarNameWithReport } from "@/features/carCare/components/CarNameWithReport";
import { rideBlockLabel } from "@/lib/rideLabel";
import { siddurCarName } from "@/lib/siddurCarName";
import { ridePassengerParts } from "@/lib/ridePassengerSummary";
import { ridePublicDetails } from "@/lib/ridePublicDetails";
import { he, t, tv } from "@/i18n/he";
import { formatTime } from "@/lib/time";
import type { Car } from "@/features/fleet/api";
import { relayPartnerOf, servedOf, type ServedEntry } from "@/features/rides/servedOf";

import type { BoardRide } from "../api";
import { AddPassengersDialog } from "@/features/rides/components/AddPassengersDialog";
import { RidePassengersList } from "@/features/rides/components/RidePassengersList";
import { RidePublicNotesEditor } from "@/features/rides/components/RidePublicNotesEditor";
import { RideRoute } from "@/features/rides/components/RideRoute";
import { RideCarHandover } from "@/features/rides/components/RideCarHandover";
import { RideRouteStops } from "@/features/rides/components/RideRouteStops";
import { parseRideRoute, routeHasIntermediates } from "@/lib/rideRoute";
import { peopleOf } from "@/features/rides/ridePeople";
import type { HandOverCandidate } from "@/features/rides/handOver";
import type { OwnCar } from "@/features/rides/useOwnCarMove";

/**
 * "<driver> ו<passengers> ל/מ<real destination>" (UX_FLOWS.md §20 — the
 * same "shows the department's own name instead of the real destination"
 * bug the Sadran board fixed for round trips, `rideBlockLabel`/
 * DATA_MODEL.md consistency decision #14) — falls back to the ride's own
 * origin/destination names (pre-fix behavior) when `homeDestinationId` isn't
 * known yet (still loading).
 */
function headerLabel(ride: BoardRide, served: readonly ServedEntry[], homeDestinationId: string | null, weekRides?: readonly BoardRide[]): string {
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
    autoRelocation: !!ride.auto_relocation,
    carMove: ride.pin_reason === "CAR_MOVE",
    startsAt: ride.starts_at ?? undefined,
    relayPartner: relayPartnerOf(ride, weekRides),
  });
}

/**
 * A round trip's extra explanatory line ("הרכב נשאר איתי ביעד" / chauffeur). A one-way/relay/
 * drop_off leg (`origin_id !== destination_id`) no longer gets a second, possibly-conflicting
 * line here — REQUIREMENTS §13.93's precise driver-label wording (`src/lib/rideLabel.ts`'s
 * "הרכב נשאר שם" / "משאיר/ה את הרכב ב…" / "הרכב מחכה ב…") already lives in `headerLabel` above.
 */
function carModeLabel(ride: BoardRide): string {
  if (ride.origin_id === ride.destination_id) {
    return ride.is_chauffeur ? he.rideDetail.carModeChauffeur : he.rideDetail.carModeKeep;
  }
  return "";
}

interface RideDetailSheetProps {
  /** The week's rides, so a relay label never names a passenger on a needs-driver partner ride (R2B19). */
  weekRides?: readonly BoardRide[];
  ride: BoardRide | null;
  car: Car | null;
  locationBadge: string | null;
  /** The department's home location — for composing the real destination on a round trip (bug fix, see `headerLabel` above). */
  homeDestinationId?: string | null;
  onOpenChange: (open: boolean) => void;
  editor?: ReactNode;
  coordinatorNotes?: string;
  canEditPublicNotes?: boolean;
  /** Available only when the signed-in member has a request served by this ride. */
  onRemoveOwnRide?: () => void;
  removingOwnRide?: boolean;
  /** REQ §13.128: a non-driver passenger removes only themselves (`remove_ride_person`), never the whole ride. */
  onRemoveMe?: () => void;
  removingMe?: boolean;
  /** REQ §13.101 f (QM5): edit link to the member's own (non-series) request on this ride. */
  editRequestHref?: string;
  /**
   * The "+ נוסעים" button and the unified people list's remove (×) affordance (REQ §13.85):
   * true once the ride's week is public (or the caller manages it) and the ride itself isn't
   * cancelled — the caller already tracks week phase for `canEditWeek`, so it computes this
   * instead of this sheet guessing at week state. Also gates `RidePassengersList`'s removal —
   * same authorization `add_ride_passengers()`/`remove_ride_person()` share.
   */
  showAddPassengers?: boolean;
  /** REQ §13.129 (a): my private cars this ride can be moved onto (empty/absent = no button). */
  moveToCarOptions?: readonly OwnCar[];
  onMoveToCar?: (carId: string) => void;
  movingToCar?: boolean;
  /** REQ §13.129 (b): drivers who can take over; when present the cancel dialog offers "remove me" first. */
  handOverOptions?: readonly HandOverCandidate[];
  onHandOver?: (newDriverId: string) => void;
  handingOver?: boolean;
}

/**
 * Ride detail sheet (UX_FLOWS.md §3.5 "Ride detail"): one unified people list (driver first,
 * then everyone else, each removable per `remove_ride_person()`'s own rules), car,
 * origin→destination. Owner decision 2026-09-14: on a published week "+ נוסעים" is the way to
 * join a ride — there is no separate "ask to join" button here any more (superseded, REQ
 * §13.85; the `/requests/new?ride=` prefill path itself is untouched, still reachable from the
 * joinable-rides dialog after a waiting-list outcome).
 */
export function RideDetailSheet({ ride, car, locationBadge, homeDestinationId = null, onOpenChange, editor, coordinatorNotes, canEditPublicNotes, onRemoveOwnRide, removingOwnRide = false, onRemoveMe, removingMe = false, editRequestHref, showAddPassengers = false, weekRides, moveToCarOptions = [], onMoveToCar, movingToCar = false, handOverOptions = [], onHandOver, handingOver = false }: RideDetailSheetProps) {
  const [confirmCancel, setConfirmCancel] = useState(false);
  const [confirmRemoveMe, setConfirmRemoveMe] = useState(false);
  const [moveCarId, setMoveCarId] = useState<string | null>(null);
  // `servedOf()` already maps `v_board_rides.served[].child_names` onto each entry's
  // `childNames` (`applySolve.ts`) — no more hand-rolled mapping needed here.
  const served: ServedEntry[] = ride ? servedOf(ride) : [];
  // Directly `add_ride_passengers()`-added names (`people`, `source: 'added'`) — not tied to
  // any served request, so `ridePublicDetails` takes them as a trailing line of their own.
  const addedNames: string[] = ride ? peopleOf(ride).filter((person) => person.source === "added").map((person) => person.display_name) : [];

  // People counted on the requests but not named anywhere (the passenger list shows only named people).
  const unnamed = ride ? ridePassengerParts(served, ride.needs_driver ? null : ride.driver_name, { addedNames }) : { adults: 0, children: 0 };
  const unnamedLine = [
    unnamed.adults ? tv(unnamed.adults === 1 ? "ridePublicDetails.unnamedAdult" : "ridePublicDetails.unnamedAdults", { count: String(unnamed.adults) }) : "",
    unnamed.children ? tv(unnamed.children === 1 ? "ridePublicDetails.unnamedChild" : "ridePublicDetails.unnamedChildren", { count: String(unnamed.children) }) : "",
  ].filter(Boolean).join(", ");
  const moveCar = moveToCarOptions.find((option) => option.id === moveCarId);
  const rideOwnerName = ride ? (ride.driver_name ?? served.find((entry) => entry.requester)?.requester ?? "") : "";

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

              <RideCarHandover ride={ride} />

              <div className="flex items-center gap-1 font-medium">
                <MapPin className="size-4 shrink-0 text-muted-foreground" />
                <span>{headerLabel(ride, served, homeDestinationId, weekRides)}</span>
              </div>

              {ride.series_count && ride.series_count > 1 ? (
                <p className="text-sm text-muted-foreground">
                  {tv("rideDetail.seriesLine", { index: String(ride.series_index ?? 1), count: String(ride.series_count) })}
                </p>
              ) : null}

              {carModeLabel(ride) ? <p className="text-muted-foreground">{carModeLabel(ride)}</p> : null}
              {routeHasIntermediates(parseRideRoute(ride.route)) ? <RideRoute route={ride.route} served={served} /> : <RideRouteStops served={served} />}
              {canEditPublicNotes && ride.id && ride.version != null ? (
                <RidePublicNotesEditor key={`${ride.id}:${ride.version}:notes`} rideId={ride.id} expectedVersion={ride.version} initialNotes={ride.notes} departmentId={ride.department_id ?? ""} weekStart={ride.week_start ?? ""} />
              ) : ride.notes ? <p className="whitespace-pre-wrap break-words">{ride.notes}</p> : null}
              {/* Owner 2026-10-12: who rides is listed once, in the passenger list below — here only the requests' descriptions. */}
              {ridePublicDetails(served, { includeCompanions: false }) ? <p className="whitespace-pre-wrap break-words">{ridePublicDetails(served, { includeCompanions: false })}</p> : null}
              {coordinatorNotes ? <div className="whitespace-pre-wrap break-words text-muted-foreground"><span className="font-medium">{he.field.notes}: </span>{coordinatorNotes}</div> : null}
              {editor}

              {/* Owner 2026-10-12: the driver is marked in the passenger list; only a missing driver / a chauffeur is said here. */}
              {ride.needs_driver ? <p className="font-semibold text-destructive">{he.rideCoordination.missingDriver}</p> : null}
              {ride.is_chauffeur && !ride.needs_driver && ride.driver_name ? <p>{he.rideDetail.chauffeur}: {ride.driver_name}</p> : null}

              {car ? (
                <p className="flex items-center gap-1">
                  <CarIcon className="size-4 shrink-0 text-muted-foreground" aria-label={he.rideDetail.car} />
                  <CarNameWithReport carId={car.id} carName={siddurCarName(car)} />
                  {car.type === "temporary" ? ` · ${he.car.type.temporary}` : ""}
                </p>
              ) : null}

              <RidePassengersList
                rideId={ride.id}
                expectedVersion={ride.version}
                people={peopleOf(ride)}
                canManagePeople={showAddPassengers}
                rideCancelled={ride.status === "cancelled"}
                departmentId={ride.department_id}
                weekStart={ride.week_start}
              />

              {unnamedLine ? <p className="text-muted-foreground">{unnamedLine}</p> : null}

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

              {editRequestHref ? (
                <Button asChild className="w-full" size="lg" variant="outline">
                  <Link to={editRequestHref}>{he.requestsList.edit}</Link>
                </Button>
              ) : null}

              {onMoveToCar && moveToCarOptions.length ? (
                <>
                  {moveToCarOptions.map((option) => (
                    <Button key={option.id} className="w-full" size="lg" variant="outline" disabled={movingToCar} onClick={() => setMoveCarId(option.id)} data-testid="move-to-my-car">
                      {moveToCarOptions.length === 1 ? he.rideDetail.moveToMyCar : tv("rideDetail.moveToCar", { car: option.name })}
                    </Button>
                  ))}
                  <ConfirmDialog
                    open={!!moveCar}
                    onOpenChange={(open) => { if (!open) setMoveCarId(null); }}
                    title={tv("rideEditing.ownCarMoveTitle", { name: rideOwnerName })}
                    description={tv("rideEditing.ownCarMoveBody", { name: rideOwnerName, car: moveCar?.name ?? "" })}
                    confirmLabel={he.rideEditing.ownCarMoveConfirm}
                    loading={movingToCar}
                    onConfirm={() => { if (moveCar) { setMoveCarId(null); onMoveToCar(moveCar.id); } }}
                  />
                </>
              ) : null}

              {onRemoveMe ? (
                <>
                  <Button className="w-full" size="lg" variant="destructive" disabled={removingMe} onClick={() => setConfirmRemoveMe(true)} data-testid="remove-me">
                    {he.rideDetail.removeMe}
                  </Button>
                  <ConfirmDialog
                    open={confirmRemoveMe}
                    onOpenChange={setConfirmRemoveMe}
                    title={he.rideDetail.removeMeConfirmTitle}
                    confirmLabel={he.rideDetail.removeMe}
                    destructive
                    loading={removingMe}
                    onConfirm={() => { setConfirmRemoveMe(false); onRemoveMe(); }}
                  />
                </>
              ) : onRemoveOwnRide ? (
                <>
                  <Button className="w-full" size="lg" variant="destructive" disabled={removingOwnRide} onClick={() => setConfirmCancel(true)}>
                    {t("action.cancelRide")}
                  </Button>
                  {/* R12M1: cancelling a ride is never one tap. */}
                  <ConfirmDialog
                    open={confirmCancel}
                    onOpenChange={setConfirmCancel}
                    title={he.request.cancelConfirmTitle}
                    confirmLabel={handOverOptions.length && onHandOver ? he.rideDetail.cancelForAll : t("action.cancelRide")}
                    destructive
                    loading={removingOwnRide || handingOver}
                    onConfirm={() => { setConfirmCancel(false); onRemoveOwnRide(); }}
                  >
                    {/* REQ §13.129 (b): the driver may instead hand the ride to someone on it who drives. */}
                    {handOverOptions.length && onHandOver ? (
                      <div className="space-y-2">
                        {handOverOptions.map((option) => (
                          <Button key={option.id} type="button" className="w-full" variant="outline" disabled={handingOver} data-testid="hand-over-option"
                            onClick={() => { setConfirmCancel(false); onHandOver(option.id); }}>
                            {tv("rideDetail.handOverOption", { name: option.name })}
                          </Button>
                        ))}
                      </div>
                    ) : null}
                  </ConfirmDialog>
                </>
              ) : null}
            </div>
          </>
        ) : null}
      </PortalSheetContent>
    </Sheet>
  );
}
