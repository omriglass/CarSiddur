import { fromZonedTime } from "date-fns-tz";
import { useState } from "react";
import { ridePublicDetails } from "@/lib/ridePublicDetails";
import { ridePassengerSummary } from "@/lib/ridePassengerSummary";
import { RidePublicNotesEditor } from "@/features/siddur/components/RidePublicNotesEditor";

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
import { formatMinutes, parseHHMM } from "@/components/TimeField15";
import { TimeField15 } from "@/components/TimeField15";
import { he, t } from "@/i18n/he";
import { TZ, dateKey, formatTime } from "@/lib/time";

import { rideBlockLabel } from "../rideLabel";
import { servedOf, withChildNames } from "../../solverRun";

import type { BoardRide, WeekRequestRow } from "../../api";
import type { Car } from "@/features/fleet/api";

export interface RideSheetSaveInput {
  carId: string;
  startsAt: string;
  endsAt: string;
  overnightAck: boolean;
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
  saving?: boolean;
  tightSchedule?: boolean;
  onClaimDriver?: () => void;
  coordinatorNotes?: string;
  isPlanning?: boolean;
  /** Every request in the week (not just this ride's) — used to attach named children (`childNames`) to `servedOf(ride)`, since `v_board_rides.served[]` itself has no child-name field yet. */
  requests?: readonly WeekRequestRow[];
}

/**
 * `RideSheet` (UX_FLOWS.md §4.2 "click block"): time/car edit, pin toggle,
 * cancel — the board's non-drag path, and (bug #2) the no-drag/touch
 * fallback for reassigning a car via the "העבר לרכב" select below instead of
 * dragging.
 */
export function RideSheet({ ride, cars, driverName, homeDestinationId, onOpenChange, onSave, onTogglePin, onCancel, onUnassign, saving, tightSchedule, onClaimDriver, coordinatorNotes, isPlanning, requests = [] }: RideSheetProps) {
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
    onSave({ carId, startsAt, endsAt, overnightAck: false });
  }

  const servedEntries = ride ? withChildNames(servedOf(ride), requests) : [];

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
              {tightSchedule ? <p className="text-xs text-amber-700">{he.boardCoordination.tight} · {he.boardCoordination.tightHelp}</p> : null}
              <p className="whitespace-pre-wrap break-words">{ridePassengerSummary(servedEntries, ride.needs_driver ? null : driverName ?? ride.driver_name)}</p>
              {ridePublicDetails(servedEntries, { includeCompanions: false }) ? <p className="whitespace-pre-wrap break-words">{ridePublicDetails(servedEntries, { includeCompanions: false })}</p> : null}
              {coordinatorNotes ? <div className="whitespace-pre-wrap break-words text-muted-foreground"><span className="font-medium">{he.field.notes}: </span>{coordinatorNotes}</div> : null}
              <p className="text-muted-foreground">
                {ride.origin_id && ride.destination_id && homeDestinationId
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
                    })
                  : `${ride.origin_name} → ${ride.destination_name} · ${driverName ?? ride.driver_name}`}
              </p>

              <div className="flex items-center gap-2">
                <TimeField15 min="00:00" value={startTime} onChange={setStartTime} aria-label={he.sadranRideSheet.depart} />
                <span>–</span>
                <TimeField15 min="00:00" max="23:59" value={endTime} onChange={setEndTime} aria-label={he.sadranRideSheet.return} />
              </div>

              <div>
                <label className="mb-1 block text-xs text-muted-foreground">{he.sadranRideSheet.moveToCar}</label>
                <Select value={carId} onValueChange={setCarId}>
                  <SelectTrigger>
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

              {isPlanning ? <p className="text-destructive">{he.boardCoordination.planning}</p> : ride.id && ride.version != null && ride.status !== "cancelled" && ride.ends_at && Date.parse(ride.ends_at) > nowMs ? (
                <RidePublicNotesEditor key={`${ride.id}:${ride.version}`} rideId={ride.id} expectedVersion={ride.version} initialNotes={ride.notes} />
              ) : ride.notes ? <p className="whitespace-pre-wrap break-words">{ride.notes}</p> : null}

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
                {onUnassign && !isPlanning ? (
                  <Button variant="outline" className="flex-1" onClick={onUnassign} disabled={saving}>
                    {he.sadranRideSheet.removeAssignment}
                  </Button>
                ) : null}
              </div>

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
