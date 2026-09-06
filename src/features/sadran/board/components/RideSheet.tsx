import { formatInTimeZone, fromZonedTime } from "date-fns-tz";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Textarea } from "@/components/ui/textarea";
import { formatMinutes, parseHHMM } from "@/components/TimeField15";
import { TimeField15 } from "@/components/TimeField15";
import { he, t } from "@/i18n/he";
import { TZ, formatTime } from "@/lib/time";

import type { BoardRide } from "../../api";
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
  onOpenChange: (open: boolean) => void;
  onSave: (input: RideSheetSaveInput) => void;
  onTogglePin: (nextPinned: boolean, reason: string | null) => void;
  onCancel: (reason: string) => void;
  saving?: boolean;
}

/** `RideSheet` (UX_FLOWS.md §4.2 "click block"): time/car edit, pin toggle, cancel — the board's non-drag path. */
export function RideSheet({ ride, cars, driverName, onOpenChange, onSave, onTogglePin, onCancel, saving }: RideSheetProps) {
  const [carId, setCarId] = useState(ride?.car_id ?? "");
  const [startTime, setStartTime] = useState(ride?.starts_at ? formatTime(new Date(ride.starts_at)) : "08:00");
  const [endTime, setEndTime] = useState(ride?.ends_at ? formatTime(new Date(ride.ends_at)) : "09:00");
  const [cancelReason, setCancelReason] = useState("");
  const [showCancelForm, setShowCancelForm] = useState(false);

  if (!ride || ride.car_id !== carId) {
    // Re-sync local state when a different ride opens (no effect needed: derived during render).
    if (ride && ride.car_id && carId !== ride.car_id) {
      setCarId(ride.car_id);
      setStartTime(ride.starts_at ? formatTime(new Date(ride.starts_at)) : "08:00");
      setEndTime(ride.ends_at ? formatTime(new Date(ride.ends_at)) : "09:00");
      setShowCancelForm(false);
    }
  }

  function dayIso(): string {
    return ride?.starts_at ? formatInTimeZone(new Date(ride.starts_at), TZ, "yyyy-MM-dd") : "";
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

  return (
    <Sheet open={!!ride} onOpenChange={onOpenChange}>
      <SheetContent side="bottom" className="max-h-[85dvh] overflow-y-auto">
        {ride ? (
          <>
            <SheetHeader>
              <SheetTitle>{he.sadranRideSheet.title}</SheetTitle>
            </SheetHeader>
            <div className="space-y-4 py-4 text-sm">
              <p className="text-muted-foreground">
                {ride.origin_name} {ride.origin_id !== ride.destination_id ? `→ ${ride.destination_name}` : ""} ·{" "}
                {driverName ?? ride.driver_name}
              </p>

              <div className="flex items-center gap-2">
                <TimeField15 value={startTime} onChange={setStartTime} aria-label={he.sadranRideSheet.depart} />
                <span>–</span>
                <TimeField15 value={endTime} onChange={setEndTime} aria-label={he.sadranRideSheet.return} />
              </div>

              <div>
                <label className="mb-1 block text-xs text-muted-foreground">{he.sadranRideSheet.car}</label>
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

              <Button className="w-full" onClick={handleSave} disabled={saving}>
                {he.sadranRideSheet.save}
              </Button>

              <div className="flex gap-2">
                <Button
                  variant="outline"
                  className="flex-1"
                  onClick={() => onTogglePin(!ride.is_pinned, ride.is_pinned ? null : "SADRAN_MANUAL")}
                >
                  {ride.is_pinned ? t("action.unpin") : t("action.pin")}
                </Button>
              </div>

              {showCancelForm ? (
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
      </SheetContent>
    </Sheet>
  );
}
