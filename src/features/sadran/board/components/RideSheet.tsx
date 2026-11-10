import { fromZonedTime } from "date-fns-tz";
import { useState } from "react";
import { useNavigate } from "react-router-dom";

import { useRequestLinkProps } from "@/app/overlayState";
import { paths } from "@/app/routes";
import { cn } from "@/lib/utils";
import { toast } from "sonner";
import { useRemoveRidePassengerMutation } from "@/features/rides/hooks";
import { useSplitRideCompanionMutation } from "../../hooks";
import { MergedPassengerDialog, type MergedPassengerChoice, type MergedPassengerTarget } from "./MergedPassengerDialog";
import { ridePublicDetails } from "@/lib/ridePublicDetails";
import { ridePassengerSummary } from "@/lib/ridePassengerSummary";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { joinableDropOffLegs } from "../joinLegs";
import { AddPassengersDialog } from "@/features/rides/components/AddPassengersDialog";
import { RidePassengersList } from "@/features/rides/components/RidePassengersList";
import { RidePersonBlocks } from "@/features/rides/components/RidePersonBlocks";
import { buildPersonBlocks, needsPersonBlocks, type RequestExtras } from "@/features/rides/ridePersonBlocks";
import { RidePublicNotesEditor } from "@/features/rides/components/RidePublicNotesEditor";
import { RideRoute } from "@/features/rides/components/RideRoute";
import { RideRouteStops } from "@/features/rides/components/RideRouteStops";
import { parseRideRoute, routeHasIntermediates, routeOverrunsWindow } from "@/lib/rideRoute";
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
import { TimeField15 } from "@/components/TimeField15";
import { formatMinutes, parseHHMM } from "@/components/timeField15Format";
import { he, t, tv } from "@/i18n/he";
import { TZ, dateKey, formatTime } from "@/lib/time";

import { rideBlockLabel } from "../rideLabel";
import { requestRouteText } from "../requestRoute";
import { isReservation } from "@/features/rides/servedOf";
import { namedPassengersOf, relayPartnerOf, servedOf, withChildNames } from "../../solverRun";
import { addedPeopleNames, peopleOf } from "@/features/rides/ridePeople";
import { RidePassengersEditor } from "./RidePassengersEditor";
import { RideRouteEditor } from "./RideRouteEditor";
import { PlanSwitchButton } from "./PlanSwitchButton";
import { TripTypeChange } from "./TripTypeChange";
import { WithdrawDuplicateAction } from "./WithdrawDuplicateAction";
import { RequestHistoryDialog } from "@/features/requests/components/RequestHistoryDialog";
import { busyDriverIds, personDayEntries } from "../driverBusy";
import { RideDriverPicker, type DriverCandidate } from "./RideDriverPicker";
import { RideCancelDialog } from "./RideCancelDialog";
import { rideCancelLines } from "../rideCancelChoices";
import { initialRouteEditValues, type RouteEditValues } from "../rideRouteEdit";

import type { BoardRide, WeekRequestRow } from "../../api";
import type { Car } from "@/features/fleet/api";

export interface RideSheetSaveInput {
  carId: string;
  startsAt: string;
  endsAt: string;
}

/** Owner 2026-11-09: "נסיעות מאוחדות" sits between סיכום and אנשים, and only on a ride that has merged guests. */
const RIDE_SHEET_TABS = ["summary", "merged", "people", "route", "actions"] as const;
type RideSheetTab = (typeof RIDE_SHEET_TABS)[number];

interface RideSheetProps {
  ride: BoardRide | null;
  cars: readonly Car[];
  driverName: string | null;
  /** For composing the same driver+passengers+direction label as the board block (bug #3) instead of a blank line when origin === destination (round trip). */
  homeDestinationId?: string | null;
  onOpenChange: (open: boolean) => void;
  onSave: (input: RideSheetSaveInput) => void;
  onTogglePin: (nextPinned: boolean, reason: string | null) => void;
  /** REQ §13.162 (a): `closeRequestIds` = the requests the Sadran marked "הנסיעה כבר לא רלוונטית"; `continueRequestIds`
   *  (O29-2 (3)) = the requests that continue on the ride (non-empty: the ride is kept for them); the rest wait. */
  onCancel: (reason: string, closeRequestIds: string[], continueRequestIds?: string[]) => void;
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
  /** Owner 2026-11-09: take a merged guest out without asking again (the passenger dialog already asked). */
  onSplitGuest?: (requestId: string, name: string) => void;
  /** REQ §13.101 (c): department members for the volunteer-driver picker; omit to hide it. */
  driverCandidates?: readonly DriverCandidate[];
  /** R8U2: a merge proposal waiting for the guest's answer on this ride; the ride stays editable, this links to the proposal. */
  pendingMerge?: { guestName: string; onOpen: () => void } | null;
  /** O28-5 (REQ §13.161 b): the ride carries an open draft (or a sent change) - its banner and actions. */
  pendingDraft?: { sent: boolean; busy?: boolean; onAgree: () => void; onSend: () => void; onDiscard: () => void } | null;
  /** Every ride of the week - lets the volunteer-driver picker mark who is busy then (R2U3). */
  otherRides?: readonly BoardRide[];
}

/**
 * `RideSheet` (UX_FLOWS.md §4.2 "click block"): time/car edit, pin toggle,
 * cancel — the board's non-drag path, and (bug #2) the no-drag/touch
 * fallback for reassigning a car via the "העבר לרכב" select below instead of
 * dragging.
 */
export function RideSheet({ ride, cars, driverName, homeDestinationId, onOpenChange, onSave, onTogglePin, onCancel, onUnassign, onJoinLegs, saving, tightSchedule, onClaimDriver, coordinatorNotes, isPlanning, requests = [], departmentId, weekStart, destinations, onSaveRoute, onRemoveAddedPerson, onSplitGuest, driverCandidates, otherRides = [], pendingMerge, pendingDraft }: RideSheetProps) {
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
  const [historyFor, setHistoryFor] = useState<{ id: string; name: string } | null>(null);
  const joinable = ride ? joinableDropOffLegs(ride, otherRides) : null;
  const [lastRideId, setLastRideId] = useState<string | null>(ride?.id ?? null);
  const [carId, setCarId] = useState(ride?.car_id ?? "");
  const [startTime, setStartTime] = useState(ride?.starts_at ? formatTime(new Date(ride.starts_at)) : "08:00");
  const [endTime, setEndTime] = useState(ride?.ends_at ? formatTime(new Date(ride.ends_at)) : "09:00");
  const [showCancelDialog, setShowCancelDialog] = useState(false);
  const [tab, setTab] = useState<RideSheetTab>("summary");
  const navigate = useNavigate();
  const requestLink = useRequestLinkProps();

  if ((ride?.id ?? null) !== lastRideId) {
    // Derived during render, no effect needed (same convention as
    // `BoardScreen.tsx`'s `policyVersionOverride`).
    setLastRideId(ride?.id ?? null);
    setCarId(ride?.car_id ?? "");
    setStartTime(ride?.starts_at ? formatTime(new Date(ride.starts_at)) : "08:00");
    setEndTime(ride?.ends_at ? formatTime(new Date(ride.ends_at)) : "09:00");
    setShowCancelDialog(false);
    setTab("summary");
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
  const addedNames = ride ? addedPeopleNames(ride, servedEntries) : [];
  // RD1: hours, flexibility and the note to the Sadran come from the week's requests the board already loaded.
  const personExtras = new Map<string, RequestExtras>(
    requests.map((request) => [request.id, {
      departAt: request.depart_at,
      returnAt: request.return_at,
      flexDepartEarly: request.flex_depart_early,
      flexDepartLate: request.flex_depart_late,
      flexReturnEarly: request.flex_return_early,
      flexReturnLate: request.flex_return_late,
      note: request.notes,
    }]),
  );

  const cancelled = ride?.status === "cancelled";
  const [passengerTarget, setPassengerTarget] = useState<MergedPassengerTarget | null>(null);
  const removePassengerMutation = useRemoveRidePassengerMutation();
  const splitCompanionMutation = useSplitRideCompanionMutation();
  const hostName = baseEntry?.requester ?? driverName ?? ride?.driver_name ?? "";
  // Owner 2026-11-09: the named companions riding on each request of a merged ride (the driver is not one of them).
  const mergedPassengers: MergedPassengerTarget[] = servedEntries.flatMap((entry) => (entry.request_id ? (entry.companions ?? [])
    .filter((person) => person.profile_id !== ride?.driver_id)
    .map((person) => ({ requestId: entry.request_id as string, profileId: person.profile_id, name: person.name, owner: entry.requester ?? "",
      ownerIsGuest: entry.request_id !== baseEntry?.request_id })) : []));

  function choosePassengerExit(choice: MergedPassengerChoice, target: MergedPassengerTarget) {
    if (!ride?.id || ride.version == null || !departmentId || !weekStart) return;
    const done = () => setPassengerTarget(null);
    if (choice === "withOwner") {
      done();
      onSplitGuest?.(target.requestId, target.owner);
    } else if (choice === "removeOnly") {
      removePassengerMutation.mutate({ rideId: ride.id, expectedVersion: ride.version, key: `comp:${target.requestId}:${target.profileId}`, departmentId, weekStart }, {
        onSuccess: () => { done(); toast.success(tv("mergedRide.passengerRemoved", { name: target.name })); },
      });
    } else {
      splitCompanionMutation.mutate({ rideId: ride.id, expectedVersion: ride.version, requestId: target.requestId, profileId: target.profileId, departmentId, weekStart }, {
        onSuccess: () => { done(); toast.success(tv("mergedRide.splitAloneDone", { name: target.name, host: hostName })); },
      });
    }
  }
  const merged = addedPeople.length > 0 && !reservation;
  // REQ §13.207: "עריכת נסיעה" opens each served request in the request form over the board (as the unplaced card's
  // "עריכת הבקשה" does); a reservation has no request, so it goes to the summary's hours and car.
  const editTargets = isPlanning || cancelled || reservation ? []
    : servedEntries.filter((entry, index, all) => !!entry.request_id && all.findIndex((other) => other.request_id === entry.request_id) === index);
  function openRequestEdit(requestId: string) {
    onOpenChange(false);
    navigate(paths.requests.edit(requestId), { state: requestLink.state });
  }
  const personBlocks = ride ? <RidePersonBlocks blocks={buildPersonBlocks({ ride, served: servedEntries, homeDestinationId, requests: personExtras })} /> : null;

  /** REQ §13.201: one line per served request - "name route ב־time", plus the people who ride with them (once). */
  function summaryLineOf(entry: ReturnType<typeof servedOf>[number]): string {
    const entryRequest = entry.request_id ? requests.find((request) => request.id === entry.request_id) : undefined;
    const route = requestRouteText({ originId: entry.origin_id, originName: entry.origin_name, originText: entry.origin_text, destination: entry.destination ?? "" }, homeDestinationId);
    const departIso = (entry.ride_leg ?? entry.leg) === "return" ? entryRequest?.return_at ?? ride?.starts_at : entryRequest?.depart_at ?? ride?.starts_at;
    const time = departIso ? formatTime(new Date(departIso)) : "";
    const name = entry.requester ?? entryRequest?.requester_full_name ?? "";
    const line = tv("sadranRideSheet.summaryLine", { name, route, time: `⁦${time}⁩` }).replace(/\s+/g, " ").trim();
    const withNames = [...(entry.companions ?? []).map((person) => person.name), ...(entry.guest_passenger_names ?? []), ...(entry.childNames ?? [])]
      .map((person) => person.trim()).filter(Boolean);
    return withNames.length ? tv("sadranRideSheet.summaryWith", { line, names: withNames.join(", ") }) : line;
  }

  return (
    <Sheet open={!!ride} onOpenChange={onOpenChange}>
      <PortalSheetContent side="bottom" className="max-h-[85dvh] overflow-y-auto">
        {ride ? (
          <>
            <SheetHeader>
              <SheetTitle>{he.sadranRideSheet.title}</SheetTitle>
            </SheetHeader>
            <div className="space-y-4 py-4 text-sm">
              {/* Banners that need attention stay above the tabs so every tab shows them. */}
              {ride.needs_driver ? <div className="space-y-2 rounded-md border border-destructive bg-destructive/10 p-3 text-destructive">
                <p className="font-semibold">{he.boardCoordination.needsDriver}</p><p>{he.boardCoordination.needsDriverHelp}</p>
                {onClaimDriver ? <Button disabled={saving} onClick={onClaimDriver}>{he.boardCoordination.claimDriver}</Button> : null}
              </div> : null}
              {pendingDraft ? <div className="space-y-2 rounded-md border-2 border-dashed border-primary p-3" data-testid="ride-draft-banner">
                <p className="text-sm font-medium">{pendingDraft.sent ? he.boardDrafts.rideBannerSent : he.boardDrafts.rideBanner}</p>
                <div className="flex flex-wrap gap-2">
                  <Button type="button" className="min-h-11" disabled={pendingDraft.busy} onClick={pendingDraft.onAgree} data-testid="ride-draft-agree">{he.boardDrafts.talkedYes}</Button>
                  {pendingDraft.sent ? null : <Button type="button" variant="outline" className="min-h-11" disabled={pendingDraft.busy} onClick={pendingDraft.onSend} data-testid="ride-draft-send">{he.boardDrafts.send}</Button>}
                  <Button type="button" variant="outline" className="min-h-11" disabled={pendingDraft.busy} onClick={pendingDraft.onDiscard} data-testid="ride-draft-discard">{pendingDraft.sent ? he.boardDrafts.withdraw : he.boardDrafts.discard}</Button>
                </div>
              </div> : null}
              {pendingMerge ? <div className="space-y-2 rounded-md border border-dashed p-3" data-testid="ride-pending-merge">
                <p>{tv("sadranRideSheet.pendingMerge", { name: pendingMerge.guestName })}</p>
                <Button type="button" variant="outline" className="min-h-11" onClick={pendingMerge.onOpen}>{he.sadranRideSheet.pendingMergeOpen}</Button>
              </div> : null}

              <Tabs value={tab} onValueChange={(value) => setTab(value as RideSheetTab)}>
                <TabsList className={cn("grid h-auto w-full", merged ? "grid-cols-5" : "grid-cols-4")} aria-label={he.sadranRideSheet.tabsLabel}>
                  {RIDE_SHEET_TABS.filter((id) => id !== "merged" || merged).map((id) => (
                    <TabsTrigger key={id} value={id} className="min-h-11 whitespace-normal px-1 text-xs sm:text-sm" data-testid={`ride-sheet-tab-${id}`}>
                      {he.sadranRideSheet.tabs[id]}
                    </TabsTrigger>
                  ))}
                </TabsList>

                {/* ── סיכום ── */}
                <TabsContent value="summary" className="space-y-4">
                  {tightSchedule ? <p className="text-xs text-amber-700">{he.boardCoordination.tight} · {he.boardCoordination.tightHelp}</p> : null}
                  {/* R17B9: a warning only — the route's times are estimates. */}
                  {routeOverrunsWindow(ride.route, ride.ends_at) ? <p className="text-xs text-amber-700" data-testid="route-overrun">{he.boardCoordination.routeOverrun}</p> : null}
                  {ride.series_count && ride.series_count > 1 ? (
                    <p className="text-muted-foreground">{tv("sadranRideSheet.seriesLine", { index: String(ride.series_index ?? 1), count: String(ride.series_count) })}</p>
                  ) : null}

                  {/* One line per served request (owner 2026-11-08: no repeated information, normal text colour). */}
                  {servedEntries.length && !reservation ? (
                    <ul className="space-y-2" data-testid="ride-sheet-requests">
                      {servedEntries.map((entry) => {
                        const entryRequest = entry.request_id ? requests.find((request) => request.id === entry.request_id) : undefined;
                        return (
                          <li key={entry.request_id ?? entry.requester} className="space-y-1">
                            <p className="whitespace-pre-wrap break-words text-foreground" data-testid="ride-sheet-summary-line">{summaryLineOf(entry)}</p>
                            {/* REQ §13.95 (H3): the Sadran changes the trip type directly. */}
                            {entry.request_id && entryRequest && departmentId && weekStart && !isPlanning && !cancelled ? (
                              <TripTypeChange
                                requestId={entry.request_id}
                                version={entryRequest.version}
                                tripType={entryRequest.trip_type ?? entry.trip_type}
                                keepCarAtDestination={entryRequest.keep_car_at_destination ?? entry.keep_car_at_destination}
                                destination={entry.destination}
                                name={entry.requester ?? entryRequest.requester_full_name ?? ""}
                                departmentId={departmentId}
                                weekStart={weekStart}
                                disabled={saving}
                              />
                            ) : null}
                            {/* REQ §13.204 (c): the request's whole story */}
                            {entry.request_id ? (
                              <Button type="button" variant="link" size="sm" className="h-auto min-h-8 px-0 text-xs" data-testid="ride-sheet-request-history"
                                onClick={() => setHistoryFor({ id: entry.request_id as string, name: entry.requester ?? entryRequest?.requester_full_name ?? "" })}>
                                {he.requestHistory.openSadran}
                              </Button>
                            ) : null}
                            {entryRequest && departmentId && weekStart && !isPlanning && !cancelled ? (
                              <PlanSwitchButton request={entryRequest} name={entry.requester ?? entryRequest.requester_full_name ?? ""} departmentId={departmentId} weekStart={weekStart} disabled={saving} />
                            ) : null}
                          </li>
                        );
                      })}
                    </ul>
                  ) : (
                    <p className="whitespace-pre-wrap break-words text-foreground" data-testid="ride-sheet-summary-line">
                      {reservation
                        ? (ridePassengerSummary(servedEntries, ride.needs_driver || volunteerShownByPicker ? null : driverName ?? ride.driver_name, { addedNames }) || (driverName ?? ride.driver_name ?? ""))
                        : ride.origin_id && ride.destination_id && homeDestinationId
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
                  )}

                  {/* `includeCompanions: false` — the people are named once, on each request's line above. */}
                  {ridePublicDetails(servedEntries, { includeCompanions: false }) ? <p className="whitespace-pre-wrap break-words">{ridePublicDetails(servedEntries, { includeCompanions: false })}</p> : null}
                  {coordinatorNotes ? <div className="whitespace-pre-wrap break-words text-muted-foreground"><span className="font-medium">{he.field.notes}: </span>{coordinatorNotes}</div> : null}

                  <div className="flex items-end gap-2">
                    <div className="flex-1 space-y-1">
                      <span className="block text-xs text-muted-foreground">{he.sadranRideSheet.depart}</span>
                      <TimeField15 min="00:00" value={startTime} onChange={setStartTime} aria-label={he.sadranRideSheet.depart} />
                    </div>
                    <span className="pb-2">–</span>
                    <div className="flex-1 space-y-1">
                      <span className="block text-xs text-muted-foreground">{he.sadranRideSheet.return}</span>
                      <TimeField15 min="00:00" max="23:59" value={endTime} onChange={setEndTime} aria-label={he.sadranRideSheet.return} />
                    </div>
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

                  <Button className="w-full" onClick={handleSave} disabled={saving}>
                    {he.sadranRideSheet.save}
                  </Button>

                  {isPlanning ? <p className="text-destructive">{he.boardCoordination.planning}</p> : ride.id && ride.version != null && !cancelled && ride.ends_at && Date.parse(ride.ends_at) > nowMs && departmentId && weekStart ? (
                    <RidePublicNotesEditor key={`${ride.id}:${ride.version}:notes`} rideId={ride.id} expectedVersion={ride.version} initialNotes={ride.notes} departmentId={departmentId} weekStart={weekStart} />
                  ) : ride.notes ? <p className="whitespace-pre-wrap break-words">{ride.notes}</p> : null}
                </TabsContent>

                {/* ── נסיעות מאוחדות ── who was merged in, how each one's hours changed, and taking them back out. */}
                {merged ? (
                  <TabsContent value="merged" className="space-y-4" data-testid="ride-sheet-merged">
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

                    {!isPlanning && !cancelled && mergedPassengers.length ? (
                      <div className="space-y-1" data-testid="ride-merged-passengers">
                        <span className="font-medium">{he.mergedRide.passengersHeading}</span>
                        <ul className="flex flex-wrap gap-2">
                          {mergedPassengers.map((target) => (
                            <li key={`${target.requestId}:${target.profileId}`} className="inline-flex items-center gap-1 rounded-full border bg-muted ps-3 text-xs" data-testid="ride-merged-passenger" data-profile-id={target.profileId}>
                              <span>{tv("mergedRide.passengerWith", { name: target.name, owner: target.owner })}</span>
                              <Button type="button" variant="ghost" size="sm" className="min-h-11 text-destructive" disabled={saving}
                                aria-label={tv("mergedRide.passengerAria", { name: target.name })}
                                onClick={() => setPassengerTarget(target)}>
                                {he.mergedRide.removeFromRide}
                              </Button>
                            </li>
                          ))}
                        </ul>
                      </div>
                    ) : null}

                    {personBlocks}
                    <MergedPassengerDialog target={passengerTarget} host={hostName} busy={removePassengerMutation.isPending || splitCompanionMutation.isPending}
                      onOpenChange={(open) => { if (!open) setPassengerTarget(null); }} onChoose={choosePassengerExit} />
                  </TabsContent>
                ) : null}

                {/* ── אנשים ── */}
                <TabsContent value="people" className="space-y-4">
                  {driverCandidates && !isPlanning && !reservation && ride.id && ride.version != null && !cancelled
                    && ride.ends_at && Date.parse(ride.ends_at) > nowMs && departmentId && weekStart ? (
                    <RideDriverPicker
                      rideId={ride.id}
                      version={ride.version}
                      needsDriver={!!ride.needs_driver}
                      volunteerName={!ride.needs_driver && ride.driver_id ? (driverName ?? ride.driver_name ?? "") : null}
                      ownRequest={servedEntries.some((entry) => entry.role === "driver")}
                      volunteerId={!ride.needs_driver && ride.driver_id ? ride.driver_id : null}
                      candidates={driverCandidates}
                      busyIds={busyDriverIds(ride, otherRides, requests)}
                      dayEntriesOf={(personId) => personDayEntries(personId, ride, otherRides, requests)}
                      placeName={(id) => destinations?.find((d) => d.id === id)?.name}
                      homeDestinationId={homeDestinationId}
                      departmentId={departmentId}
                      weekStart={weekStart}
                      disabled={saving}
                      published={ride.status !== "draft"}
                      onDone={() => onOpenChange(false)}
                    />
                  ) : null}

                  {/* F3 (20260914120000_ride_passengers.sql): editing named people on an
                      existing manual reservation, same editability gate as the notes editor
                      (not planning, not cancelled, still in the future). */}
                  {!isPlanning && ride.pin_reason === "SADRAN_MANUAL" && ride.id && ride.version != null
                    && !cancelled && ride.ends_at && Date.parse(ride.ends_at) > nowMs && departmentId && weekStart ? (
                    <RidePassengersEditor
                      key={`${ride.id}:${ride.version}:passengers`}
                      rideId={ride.id}
                      expectedVersion={ride.version}
                      departmentId={departmentId}
                      weekStart={weekStart}
                      initialPassengers={namedPassengersOf(ride)}
                    />
                  ) : null}

                  {/* "+ נוסעים" (REQ §13.85): appends, works on any confirmed, uncancelled ride. Same unified
                      `people` list the siddur's `RideDetailSheet` renders. */}
                  {!merged && needsPersonBlocks(ride, servedEntries) ? personBlocks : null}
                  <RidePassengersList
                    rideId={ride.id}
                    expectedVersion={ride.version}
                    people={peopleOf(ride)}
                    served={servedEntries}
                    canManagePeople={!isPlanning}
                    rideCancelled={cancelled}
                    departmentId={departmentId}
                    weekStart={weekStart}
                    requestRowsLocked={merged}
                  />
                  {!isPlanning && ride.id && ride.version != null && !cancelled && departmentId && weekStart ? (
                    <AddPassengersDialog
                      key={`${ride.id}:${ride.version}:add-passengers`}
                      rideId={ride.id}
                      expectedVersion={ride.version}
                      departmentId={departmentId}
                      weekStart={weekStart}
                      people={peopleOf(ride)}
                    />
                  ) : null}
                </TabsContent>

                {/* ── יעדים ── */}
                <TabsContent value="route" className="space-y-4">
                  {reservation ? null : routeHasIntermediates(parseRideRoute(ride.route)) ? <RideRoute route={ride.route} served={servedEntries} /> : <RideRouteStops served={servedEntries} />}

                  {/* REQ §13.94 (G8): start, end and stops per leg. */}
                  {!reservation && onSaveRoute && destinations && !isPlanning && ride.id && !cancelled && (baseRequest || !servedEntries.length) ? (
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
                  ) : cancelled || reservation || isPlanning ? <p className="text-muted-foreground">{cancelled ? he.sadranRideSheet.cancelledNote : he.sadranRideSheet.noRoute}</p> : null}
                </TabsContent>

                {/* ── פעולות ── */}
                <TabsContent value="actions" className="space-y-4">
                  {editTargets.length ? (
                    <div className="space-y-2" data-testid="ride-sheet-edit">
                      {editTargets.map((entry) => {
                        const name = entry.requester ?? requests.find((request) => request.id === entry.request_id)?.requester_full_name ?? "";
                        return (
                          <Button key={entry.request_id} className="w-full" disabled={saving} data-testid="ride-sheet-edit-request" data-request-id={entry.request_id ?? undefined}
                            onClick={() => openRequestEdit(entry.request_id as string)}>
                            {editTargets.length > 1 && name ? tv("sadranRideSheet.editRideOf", { name }) : he.sadranRideSheet.editRide}
                          </Button>
                        );
                      })}
                      <p className="text-xs text-muted-foreground">{he.sadranRideSheet.helpEditRide}</p>
                    </div>
                  ) : reservation && !isPlanning && !cancelled ? (
                    <div className="space-y-1" data-testid="ride-sheet-edit">
                      <Button className="w-full" onClick={() => setTab("summary")} data-testid="ride-sheet-edit-reservation">{he.sadranRideSheet.editRide}</Button>
                      <p className="text-xs text-muted-foreground">{he.sadranRideSheet.helpEditReservation}</p>
                    </div>
                  ) : null}
                  {!isPlanning ? (
                    <div className="space-y-1">
                      <Button variant="outline" className="w-full" onClick={() => onTogglePin(!ride.is_pinned, ride.is_pinned ? null : "SADRAN_MANUAL")}>
                        {ride.is_pinned ? t("action.unpin") : t("action.pin")}
                      </Button>
                      <p className="text-xs text-muted-foreground">{ride.is_pinned ? he.sadranRideSheet.helpUnpin : he.sadranRideSheet.helpPin}</p>
                    </div>
                  ) : null}
                  {joinable && onJoinLegs && !isPlanning ? (
                    <div className="space-y-1">
                      <Button variant="outline" className="w-full" onClick={() => onJoinLegs(joinable.requestId)} disabled={saving} data-testid="join-legs">
                        {he.sadranRideSheet.joinLegs}
                      </Button>
                      <p className="text-xs text-muted-foreground">{he.sadranRideSheet.helpJoinLegs}</p>
                    </div>
                  ) : null}
                  {onUnassign && !isPlanning && !ride.series_id && !reservation ? (
                    <div className="space-y-1">
                      <Button variant="outline" className="w-full" onClick={onUnassign} disabled={saving}>
                        {he.sadranRideSheet.removeAssignment}
                      </Button>
                      <p className="text-xs text-muted-foreground">{he.sadranRideSheet.helpUnassign}</p>
                    </div>
                  ) : null}
                  {onUnassign && !isPlanning && ride.series_id ? (
                    <p className="text-xs text-muted-foreground">{he.sadranBoard.seriesUnassignHint}</p>
                  ) : null}
                  {servedEntries.map((entry) => {
                    const entryRequest = entry.request_id ? requests.find((request) => request.id === entry.request_id) : undefined;
                    if (!(entry.request_id && entryRequest && !entryRequest.series_id && departmentId && weekStart && !isPlanning && !cancelled)) return null;
                    const name = entry.requester ?? entryRequest.requester_full_name ?? "";
                    return (
                      <div key={entry.request_id} className="space-y-1">
                        {servedEntries.length > 1 && name ? <p className="text-xs font-medium">{name}</p> : null}
                        <WithdrawDuplicateAction
                          requestId={entry.request_id}
                          version={entryRequest.version}
                          name={name}
                          departmentId={departmentId}
                          weekStart={weekStart}
                          disabled={saving}
                          className="w-full"
                        />
                        <p className="text-xs text-muted-foreground">{he.sadranRideSheet.helpDuplicate}</p>
                      </div>
                    );
                  })}

                  {/* REQ §13.194: a reservation has one way out - deleting it, undoable from the toast / ↶ (unassign_ride). */}
                  <div className="space-y-1 border-t pt-4">
                    {isPlanning ? (
                      <>
                        <Button variant="outline" className="w-full" onClick={() => onCancel("", [])} disabled={saving}>{he.boardCoordination.cancelPlanning}</Button>
                        <p className="text-xs text-muted-foreground">{he.sadranRideSheet.helpCancelPlanning}</p>
                      </>
                    ) : reservation && onUnassign ? (
                      <>
                        <Button variant="destructive" className="w-full" onClick={onUnassign} disabled={saving} data-testid="ride-sheet-remove-reservation">
                          {he.sadranRideSheet.removeReservation}
                        </Button>
                        <p className="text-xs text-muted-foreground">{he.sadranRideSheet.helpRemoveReservation}</p>
                      </>
                    ) : (
                      <>
                        <Button variant="destructive" className="w-full" onClick={() => setShowCancelDialog(true)} data-testid="ride-sheet-cancel">
                          {t("action.cancelRide")}
                        </Button>
                        <p className="text-xs text-muted-foreground">{he.sadranRideSheet.helpCancel}</p>
                        <RideCancelDialog
                          open={showCancelDialog}
                          onOpenChange={setShowCancelDialog}
                          lines={rideCancelLines(servedOf(ride))}
                          series={!!ride.series_id}
                          loading={saving}
                          onConfirm={(reason, closeIds, continueIds) => onCancel(reason, closeIds, continueIds)}
                        />
                      </>
                    )}
                  </div>
                </TabsContent>
              </Tabs>
            </div>
          </>
        ) : null}
        {historyFor ? <RequestHistoryDialog requestId={historyFor.id} subtitle={historyFor.name} open onOpenChange={(value) => { if (!value) setHistoryFor(null); }} /> : null}
      </PortalSheetContent>
    </Sheet>
  );
}
