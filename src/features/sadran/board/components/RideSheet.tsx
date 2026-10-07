import { fromZonedTime } from "date-fns-tz";
import { useState } from "react";
import { ridePublicDetails } from "@/lib/ridePublicDetails";
import { ridePassengerSummary } from "@/lib/ridePassengerSummary";
import { joinableDropOffLegs } from "../joinLegs";
import { AddPassengersDialog } from "@/features/rides/components/AddPassengersDialog";
import { RidePassengersList } from "@/features/rides/components/RidePassengersList";
import { RidePublicNotesEditor } from "@/features/rides/components/RidePublicNotesEditor";
import { RideRoute } from "@/features/rides/components/RideRoute";
import { RideRouteStops } from "@/features/rides/components/RideRouteStops";
import { parseRideRoute, routeHasIntermediates } from "@/lib/rideRoute";
import type { DestinationPreset } from "@/components/DestinationCombobox";

import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Sheet, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { PortalSheetContent } from "@/components/PortalSheetContent";
import { Textarea } from "@/components/ui/textarea";
import { TimeField15 } from "@/components/TimeField15";
import { formatMinutes, parseHHMM } from "@/components/timeField15Format";
import { he, t, tv } from "@/i18n/he";
import { TZ, dateKey, formatTime } from "@/lib/time";

import { rideBlockLabel } from "../rideLabel";
import { requestRouteLine } from "../requestRoute";
import { isReservation } from "@/features/rides/servedOf";
import { namedPassengersOf, relayPartnerOf, servedOf, withChildNames } from "../../solverRun";
import { peopleOf } from "@/features/rides/ridePeople";
import { RidePassengersEditor } from "./RidePassengersEditor";
import { RideRouteEditor } from "./RideRouteEditor";
import { TripTypeChange } from "./TripTypeChange";
import { WithdrawDuplicateAction } from "./WithdrawDuplicateAction";
import { busyDriverIds } from "../driverBusy";
import { RideDriverPicker, type DriverCandidate } from "./RideDriverPicker";
import { initialRouteEditValues, type RouteEditValues } from "../rideRouteEdit";

import type { BoardRide, WeekRequestRow } from "../../api";
import type { Car } from "@/features/fleet/api";

export interface RideSheetSaveInput {
  carId: string;
  startsAt: string;
  endsAt: string;
}

interface RideSheetProps {
  ride: BoardRide | null;
  cars: readonly Car[];
  driverName: string | null;
  /** For composing the same driver+passengers+direction label as the board block (bug #3) instead of a blank line when origin === destination (round trip). */
  homeDestinationId?: string | null;
  onOpenChange: (open: boolean) => void;
  onSave: (input: RideSheetSaveInput) => void;
  onTogglePin: (nextPinned: boolean, reason: string | null) => void;
  onCancel: (reason: string) => void;
  /** Return served requests to the unmet board without cancelling them. */
  onUnassign?: () => void;
  /** REQ §13.105 c: join this הקפצה's drop-off and pickup rides into one (the request id comes from `joinableDropOffLegs`). */
  onJoinLegs?: (requestId: string) => void;
  saving?: boolean;
  tightSchedule?: boolean;
  onClaimDriver?: () => void;
  coordinatorNotes?: string;
  isPlanning?: boolean;
  /** Every request in the week (not just this ride's) — used to attach named children (`childNames`) to `servedOf(ride)`, since `v_board_rides.served[]` itself has no child-name field yet. */
  requests?: readonly WeekRequestRow[];
  /** For `RidePassengersEditor` (F3) — only rendered for a manual reservation, which always belongs to exactly one department/week. */
  departmentId?: string;
  weekStart?: string;
  /** REQ §13.94 (G8): list places for the "מסלול" editor; omit to hide the section. */
  destinations?: readonly DestinationPreset[];
  /** Saves the "מסלול" section (shift proposal for a served request, `edit_ride` for a reservation). */
  onSaveRoute?: (values: RouteEditValues) => void;
  /** REQ §13.94 (G10): "הוצא מהנסיעה" for an added person of a merged ride. */
  onRemoveAddedPerson?: (requestId: string, name: string) => void;
  /** REQ §13.101 (c): department members for the volunteer-driver picker; omit to hide it. */
  driverCandidates?: readonly DriverCandidate[];
  /** Every ride of the week - lets the volunteer-driver picker mark who is busy then (R2U3). */
  otherRides?: readonly BoardRide[];
}

/**
 * `RideSheet` (UX_FLOWS.md §4.2 "click block"): time/car edit, pin toggle,
 * cancel — the board's non-drag path, and (bug #2) the no-drag/touch
 * fallback for reassigning a car via the "העבר לרכב" select below instead of
 * dragging.
 */
export function RideSheet({ ride, cars, driverName, homeDestinationId, onOpenChange, onSave, onTogglePin, onCancel, onUnassign, onJoinLegs, saving, tightSchedule, onClaimDriver, coordinatorNotes, isPlanning, requests = [], departmentId, weekStart, destinations, onSaveRoute, onRemoveAddedPerson, driverCandidates, otherRides = [] }: RideSheetProps) {
  // Bug-fix pass (owner bug #2): the previous re-sync condition compared
  // `ride.car_id !== carId` to detect "a different ride opened" — but that's
  // exactly as true the moment the Sadran picks a *different* car for the
  // *same* open ride via the select below (`onValueChange` sets `carId` to
  // something that, by definition, no longer equals `ride.car_id` until
  // saved). Every render after that pick re-entered this block and reset
  // `carId` straight back to `ride.car_id`, so the "העבר לרכב" no-drag
  // fallback silently could never actually change the selection — reproduced
  // in `e2e/board.spec.ts`. Fixed by keying the reset on the ride's own
  // `id` (only a genuinely different ride, or closing and reopening the
  // same one, resets the local fields), not on whether `carId` happens to
  // differ from the ride's persisted value.
  const [nowMs] = useState(() => Date.now());
  const joinable = ride ? joinableDropOffLegs(ride, otherRides) : null;
  const [lastRideId, setLastRideId] = useState<string | null>(ride?.id ?? null);
  const [carId, setCarId] = useState(ride?.car_id ?? "");
  const [startTime, setStartTime] = useState(ride?.starts_at ? formatTime(new Date(ride.starts_at)) : "08:00");
  const [endTime, setEndTime] = useState(ride?.ends_at ? formatTime(new Date(ride.ends_at)) : "09:00");
  const [cancelReason, setCancelReason] = useState("");
  const [showCancelForm, setShowCancelForm] = useState(false);

  if ((ride?.id ?? null) !== lastRideId) {
    // Derived during render, no effect needed (same convention as
    // `BoardScreen.tsx`'s `policyVersionOverride`).
    setLastRideId(ride?.id ?? null);
    setCarId(ride?.car_id ?? "");
    setStartTime(ride?.starts_at ? formatTime(new Date(ride.starts_at)) : "08:00");
    setEndTime(ride?.ends_at ? formatTime(new Date(ride.ends_at)) : "09:00");
    setShowCancelForm(false);
  }

  function dayIso(): string {
    return ride?.starts_at ? dateKey(ride.starts_at) : "";
  }

  function handleSave() {
    if (!ride?.starts_at || !ride.ends_at) return;
    const day = dayIso();
    const startMin = parseHHMM(startTime) ?? 0;
    const endMin = parseHHMM(endTime) ?? 0;
    const startsAt = fromZonedTime(`${day}T${formatMinutes(startMin)}:00`, TZ).toISOString();
    const endsAt = fromZonedTime(`${day}T${formatMinutes(endMin)}:00`, TZ).toISOString();
    onSave({ carId, startsAt, endsAt });
  }

  const reservation = !!ride && isReservation(ride);
  // R3B16: a volunteer driver is shown by the driver picker (name + remove); the passenger summary below must not repeat it.
  const volunteerShownByPicker = !!ride && !!driverCandidates && !ride.needs_driver && !!ride.driver_id && !servedOf(ride).some((entry) => entry.role === "driver");
  const servedEntries = ride ? withChildNames(servedOf(ride), requests) : [];
  // Everyone but the base request (the driver's, else the first) was added by a merge.
  const baseEntry = servedEntries.find((entry) => entry.role === "driver") ?? servedEntries[0];
  const addedPeople = servedEntries.filter((entry) => entry.request_id && entry.request_id !== baseEntry?.request_id);
  const baseRequest = baseEntry?.request_id ? requests.find((request) => request.id === baseEntry.request_id) : undefined;
  // Directly `add_ride_passengers()`-added names (`people`, `source: 'added'`) — not tied to
  // any served request, so the summary/details lines take them as an extra list of their own.
  const addedNames = ride ? peopleOf(ride).filter((person) => person.source === "added").map((person) => person.display_name) : [];

  return (
    <Sheet open={!!ride} onOpenChange={onOpenChange}>
      <PortalSheetContent side="bottom" className="max-h-[85dvh] overflow-y-auto">
        {ride ? (
          <>
            <SheetHeader>
              <SheetTitle>{he.sadranRideSheet.title}</SheetTitle>
            </SheetHeader>
            <div className="space-y-4 py-4 text-sm">
              {ride.needs_driver ? <div className="space-y-2 rounded-md border border-destructive bg-destructive/10 p-3 text-destructive">
                <p className="font-semibold">{he.boardCoordination.needsDriver}</p><p>{he.boardCoordination.needsDriverHelp}</p>
                {onClaimDriver ? <Button disabled={saving} onClick={onClaimDriver}>{he.boardCoordination.claimDriver}</Button> : null}
              </div> : null}
              {driverCandidates && !isPlanning && !reservation && ride.id && ride.version != null && ride.status !== "cancelled"
                && ride.ends_at && Date.parse(ride.ends_at) > nowMs && departmentId && weekStart ? (
                <RideDriverPicker
                  key={`${ride.id}:${ride.version}`}
                  rideId={ride.id}
                  version={ride.version}
                  needsDriver={!!ride.needs_driver}
                  volunteerName={!ride.needs_driver && ride.driver_id && !servedEntries.some((entry) => entry.role === "driver") ? (driverName ?? ride.driver_name ?? "") : null}
                  candidates={driverCandidates}
                  busyIds={busyDriverIds(ride, otherRides, requests)}
                  placeName={(id) => destinations?.find((d) => d.id === id)?.name}
                  homeDestinationId={homeDestinationId}
                  departmentId={departmentId}
                  weekStart={weekStart}
                  disabled={saving}
                  published={ride.status !== "draft"}
                  onDone={() => onOpenChange(false)}
                />
              ) : null}
              {tightSchedule ? <p className="text-xs text-amber-700">{he.boardCoordination.tight} · {he.boardCoordination.tightHelp}</p> : null}
              {ride.series_count && ride.series_count > 1 ? (
                <p className="text-muted-foreground">{tv("sadranRideSheet.seriesLine", { index: String(ride.series_index ?? 1), count: String(ride.series_count) })}</p>
              ) : null}
              <p className="whitespace-pre-wrap break-words">{ridePassengerSummary(servedEntries, ride.needs_driver || volunteerShownByPicker ? null : driverName ?? ride.driver_name, { addedNames })}</p>
              {/* `includeCompanions: false` here — the summary line above already lists every
                  named person, added ones included; this is only the free-text description. */}
              {ridePublicDetails(servedEntries, { includeCompanions: false }) ? <p className="whitespace-pre-wrap break-words">{ridePublicDetails(servedEntries, { includeCompanions: false })}</p> : null}
              {coordinatorNotes ? <div className="whitespace-pre-wrap break-words text-muted-foreground"><span className="font-medium">{he.field.notes}: </span>{coordinatorNotes}</div> : null}
              <p className="text-muted-foreground">
                {reservation ? (driverName ?? ride.driver_name ?? "") : ride.origin_id && ride.destination_id && homeDestinationId
                  ? rideBlockLabel({
                      originId: ride.origin_id,
                      destinationId: ride.destination_id,
                      originName: ride.origin_name ?? "",
                      destinationName: ride.destination_name ?? "",
                      homeDestinationId,
                      served: servedOf(ride),
                      driverName: driverName ?? ride.driver_name,
                      isChauffeur: !!ride.is_chauffeur,
                      needsDriver: !!ride.needs_driver,
                      autoRelocation: !!ride.auto_relocation,
                      carMove: ride.pin_reason === "CAR_MOVE",
                      startsAt: ride.starts_at ?? undefined,
                      relayPartner: relayPartnerOf(ride, otherRides),
                    })
                  : `${ride.origin_name} → ${ride.destination_name} · ${driverName ?? ride.driver_name}`}
              </p>

              {/* G6: each served request's own start/destination and trip type. */}
              <ul className="space-y-0.5 text-xs text-muted-foreground" data-testid="ride-sheet-requests">
                {servedEntries.map((entry) => {
                  const entryRequest = entry.request_id ? requests.find((request) => request.id === entry.request_id) : undefined;
                  return (
                    <li key={entry.request_id} className="space-y-1">
                      <span>
                        {entry.requester ? `${entry.requester}: ` : ""}
                        {requestRouteLine({ originId: entry.origin_id, originName: entry.origin_name, originText: entry.origin_text, destination: entry.destination ?? "", tripType: entry.trip_type }, homeDestinationId)}
                      </span>
                      {/* REQ §13.95 (H3): the Sadran changes the trip type directly. */}
                      {entry.request_id && entryRequest && departmentId && weekStart && !isPlanning && ride.status !== "cancelled" ? (
                        <TripTypeChange
                          requestId={entry.request_id}
                          version={entryRequest.version}
                          tripType={entryRequest.trip_type ?? entry.trip_type}
                          name={entry.requester ?? entryRequest.requester_full_name ?? ""}
                          departmentId={departmentId}
                          weekStart={weekStart}
                          disabled={saving}
                        />
                      ) : null}
                      {entry.request_id && entryRequest && !entryRequest.series_id && departmentId && weekStart && !isPlanning && ride.status !== "cancelled" ? (
                        <WithdrawDuplicateAction
                          requestId={entry.request_id}
                          version={entryRequest.version}
                          name={entry.requester ?? entryRequest.requester_full_name ?? ""}
                          departmentId={departmentId}
                          weekStart={weekStart}
                          disabled={saving}
                        />
                      ) : null}
                    </li>
                  );
                })}
              </ul>

              {reservation ? null : routeHasIntermediates(parseRideRoute(ride.route)) ? <RideRoute route={ride.route} served={servedEntries} /> : <RideRouteStops served={servedEntries} />}

              {/* REQ §13.94 (G10): people added to this ride by a merge - take them back out
                  (a draft/sent merge is discarded/withdrawn, an applied one un-merged). */}
              {onRemoveAddedPerson && !isPlanning && addedPeople.length ? (
                <div className="space-y-1" data-testid="ride-added-people">
                  <span className="font-medium">{he.mergedRide.addedPeople}</span>
                  <ul className="flex flex-wrap gap-2">
                    {addedPeople.map((entry) => (
                      <li key={entry.request_id} className="inline-flex items-center gap-1 rounded-full border bg-muted ps-3 text-xs" data-testid="ride-added-person" data-request-id={entry.request_id ?? undefined}>
                        <span>{entry.requester ?? ""}</span>
                        <Button type="button" variant="ghost" size="sm" className="min-h-11 text-destructive" disabled={saving}
                          aria-label={tv("mergedRide.removeAria", { name: entry.requester ?? "" })}
                          onClick={() => onRemoveAddedPerson(entry.request_id as string, entry.requester ?? "")}>
                          {he.mergedRide.removeFromRide}
                        </Button>
                      </li>
                    ))}
                  </ul>
                </div>
              ) : null}

              <div className="flex items-center gap-2">
                <TimeField15 min="00:00" value={startTime} onChange={setStartTime} aria-label={he.sadranRideSheet.depart} />
                <span>–</span>
                <TimeField15 min="00:00" max="23:59" value={endTime} onChange={setEndTime} aria-label={he.sadranRideSheet.return} />
              </div>

              <div>
                <label className="mb-1 block text-xs text-muted-foreground">{he.sadranRideSheet.moveToCar}</label>
                <Select value={carId} onValueChange={setCarId}>
                  <SelectTrigger data-testid="ride-car-select">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {cars.map((c) => (
                      <SelectItem key={c.id} value={c.id}>
                        {c.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              {isPlanning ? <p className="text-destructive">{he.boardCoordination.planning}</p> : ride.id && ride.version != null && ride.status !== "cancelled" && ride.ends_at && Date.parse(ride.ends_at) > nowMs && departmentId && weekStart ? (
                <RidePublicNotesEditor key={`${ride.id}:${ride.version}`} rideId={ride.id} expectedVersion={ride.version} initialNotes={ride.notes} departmentId={departmentId} weekStart={weekStart} />
              ) : ride.notes ? <p className="whitespace-pre-wrap break-words">{ride.notes}</p> : null}

              {/* F3 (20260914120000_ride_passengers.sql): editing named people on an
                  existing manual reservation, same editability gate as the notes editor
                  above (not planning, not cancelled, still in the future). */}
              {!isPlanning && ride.pin_reason === "SADRAN_MANUAL" && ride.id && ride.version != null
                && ride.status !== "cancelled" && ride.ends_at && Date.parse(ride.ends_at) > nowMs && departmentId && weekStart ? (
                <RidePassengersEditor
                  key={`${ride.id}:${ride.version}:passengers`}
                  rideId={ride.id}
                  expectedVersion={ride.version}
                  departmentId={departmentId}
                  weekStart={weekStart}
                  initialPassengers={namedPassengersOf(ride)}
                />
              ) : null}

              {/* "+ נוסעים" (REQ §13.85): unlike `RidePassengersEditor` above (a Sadran
                  reservation's *replace* editor, manual reservations only), this appends and
                  works on any confirmed, uncancelled ride — the board's own authorized
                  viewer always satisfies `can_manage_week` for this week. Same unified
                  `people` list the siddur's `RideDetailSheet` renders (REQ §13.85). */}
              <RidePassengersList
                rideId={ride.id}
                expectedVersion={ride.version}
                people={peopleOf(ride)}
                canManagePeople={!isPlanning}
                rideCancelled={ride.status === "cancelled"}
                departmentId={departmentId}
                weekStart={weekStart}
              />
              {!isPlanning && ride.id && ride.version != null && ride.status !== "cancelled" && departmentId && weekStart ? (
                <AddPassengersDialog
                  key={`${ride.id}:${ride.version}:add-passengers`}
                  rideId={ride.id}
                  expectedVersion={ride.version}
                  departmentId={departmentId}
                  weekStart={weekStart}
                  people={peopleOf(ride)}
                />
              ) : null}

              {/* REQ §13.94 (G8): start, end and stops per leg. */}
              {!reservation && onSaveRoute && destinations && !isPlanning && ride.id && ride.status !== "cancelled" && (baseRequest || !servedEntries.length) ? (
                <RideRouteEditor
                  key={`${ride.id}:${ride.version}:route`}
                  initial={initialRouteEditValues({
                    request: baseRequest ?? null,
                    stops: baseEntry?.stops ?? [],
                    ride,
                    homeId: homeDestinationId,
                    placeName: (id) => destinations.find((d) => d.id === id)?.name,
                  })}
                  destinations={destinations}
                  stopsEditable={!!baseRequest}
                  hasReturn={baseRequest?.trip_shape === "round_trip"}
                  saving={saving}
                  onSave={onSaveRoute}
                />
              ) : null}

              <Button className="w-full" onClick={handleSave} disabled={saving}>
                {he.sadranRideSheet.save}
              </Button>

              <div className="flex gap-2">
                {!isPlanning ? <Button
                  variant="outline"
                  className="flex-1"
                  onClick={() => onTogglePin(!ride.is_pinned, ride.is_pinned ? null : "SADRAN_MANUAL")}
                >
                  {ride.is_pinned ? t("action.unpin") : t("action.pin")}
                </Button> : null}
                {joinable && onJoinLegs && !isPlanning ? (
                  <Button variant="outline" className="flex-1" onClick={() => onJoinLegs(joinable.requestId)} disabled={saving} data-testid="join-legs">
                    {he.sadranRideSheet.joinLegs}
                  </Button>
                ) : null}
                {onUnassign && !isPlanning && !ride.series_id ? (
                  <Button variant="outline" className="flex-1" onClick={onUnassign} disabled={saving}>
                    {he.sadranRideSheet.removeAssignment}
                  </Button>
                ) : null}
              </div>
              {onUnassign && !isPlanning && ride.series_id ? (
                <p className="text-xs text-muted-foreground">{he.sadranBoard.seriesUnassignHint}</p>
              ) : null}

              {isPlanning ? <Button variant="outline" onClick={() => onCancel("")} disabled={saving}>{he.boardCoordination.cancelPlanning}</Button> : showCancelForm ? (
                <div className="space-y-2 rounded-md border border-destructive/40 p-3">
                  <Textarea
                    value={cancelReason}
                    onChange={(e) => setCancelReason(e.target.value)}
                    placeholder={he.sadranBoard.cancelRidePrompt}
                  />
                  <Button
                    variant="destructive"
                    className="w-full"
                    onClick={() => onCancel(cancelReason || "SADRAN_EDIT")}
                    disabled={saving}
                  >
                    {t("action.cancelRide")}
                  </Button>
                </div>
              ) : (
                <Button variant="destructive" className="w-full" onClick={() => setShowCancelForm(true)}>
                  {t("action.cancelRide")}
                </Button>
              )}
            </div>
          </>
        ) : null}
      </PortalSheetContent>
    </Sheet>
  );
}
