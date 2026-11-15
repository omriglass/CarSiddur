// R20H1 (owner 2026-11-14): "לבטל רק את ד׳ 16.9" in the cancel dialog of one day of a multi-day ride. The usual
// "הרכב יתפנה לאחרים" check runs first (as for every cancel); then the day is cut out of the series and cancelled in
// one call (`cancel_series_day`), the other days keep the car.
import { toast } from "sonner";

import type { BoardRide } from "@/features/rides/api";
import { FreedCarConfirmDialog } from "@/features/rides/FreedCarConfirmDialog";
import { useFreedCarGate } from "@/features/rides/useFreedCar";
import { tv } from "@/i18n/he";
import { withFreedCarChoice } from "@/lib/appSurface";
import { formatDayDate } from "@/lib/dayLabels";

import { cancelSeriesDayArgs } from "./api";
import { useCancelSeriesDayMutation } from "./hooks";

/** Whether the ride is one day of a multi-day ride (the dialog then offers "only this day"). */
export function isSeriesDay(ride: Pick<BoardRide, "series_id" | "series_count"> | null | undefined): boolean {
  return !!ride?.series_id && (ride.series_count ?? 0) > 1;
}

export function useCancelSeriesDay() {
  const mutation = useCancelSeriesDayMutation();
  const gate = useFreedCarGate();

  function start(ride: BoardRide, onDone: () => void) {
    if (!ride.id || ride.version == null || !ride.starts_at) return;
    const rideId = ride.id;
    const version = ride.version;
    const day = formatDayDate(ride.starts_at);
    void gate.run({ action: "cancel_series_day", args: cancelSeriesDayArgs(rideId, version) }, (keepOut) => {
      void withFreedCarChoice(keepOut, () => mutation.mutateAsync({ rideId, expectedVersion: version }))
        .then(() => { toast.success(tv("request.cancelOnlyDayDone", { day })); onDone(); }, () => undefined);
    });
  }

  return { start, busy: mutation.isPending || gate.checking, dialog: <FreedCarConfirmDialog dialog={gate.dialog} /> };
}
