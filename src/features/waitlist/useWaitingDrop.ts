import { useQueryClient } from "@tanstack/react-query";
import { fromZonedTime } from "date-fns-tz";
import { useState } from "react";
import { toast } from "sonner";

import { formatMinutes } from "@/components/timeField15Format";
import { invalidateWeekData } from "@/features/rides/invalidateWeek";
import { he, tv } from "@/i18n/he";
import { showErrorToast } from "@/lib/rpc";
import { TZ } from "@/lib/time";

import { placeWaitingRequest } from "./api";
import { waitlistKeys } from "./keys";
import type { PlaceWaitingWarning, WaitingRequest } from "./types";

interface PendingDrop {
  request: WaitingRequest;
  carId: string;
  carName: string;
  departAt: string;
  returnAt: string;
  warnings: PlaceWaitingWarning[];
}

/**
 * REQ §13.183: a waiting round trip dropped onto a car column, keeping its length. The server decides: placed (toast),
 * refused (toast with the reason, nothing changes), or warnings the member may accept ("לשבץ בכל זאת?").
 */
export function useWaitingDrop(departmentId: string | undefined, weekStart: string | undefined) {
  const queryClient = useQueryClient();
  const [pending, setPending] = useState<PendingDrop | null>(null);
  const [saving, setSaving] = useState(false);

  /** Only an upcoming round trip is draggable (the server also refuses a multi-day one); the rest open the form. */
  function canDrag(request: WaitingRequest | undefined): boolean {
    return !!request && request.trip_type === "round_trip" && Date.parse(request.starts_at) > Date.now();
  }

  async function submit(drop: Omit<PendingDrop, "warnings">, accept: string[]) {
    if (!departmentId || !weekStart) return;
    setSaving(true);
    try {
      const result = await placeWaitingRequest({
        requestId: drop.request.request_id, carId: drop.carId, departAt: drop.departAt, returnAt: drop.returnAt,
        expectedVersion: drop.request.version, accept,
      });
      if (result.ok) {
        setPending(null);
        toast.success(tv("waitlist.dropPlaced", { car: drop.carName }));
        void queryClient.invalidateQueries({ queryKey: waitlistKeys.all });
        void invalidateWeekData(queryClient, departmentId, weekStart, [result.ride_id]);
      } else if (result.blocked) {
        setPending(null);
        toast.error(he.waitlist.dropBlocked[result.blocked]);
      } else if (result.warnings?.length) {
        setPending({ ...drop, warnings: result.warnings });
      }
    } catch (error) {
      setPending(null);
      showErrorToast(error);
    } finally {
      setSaving(false);
    }
  }

  function drop(request: WaitingRequest, carId: string, carName: string, startMinutes: number) {
    const length = (Date.parse(request.ends_at) - Date.parse(request.starts_at)) / 60_000;
    const endMinutes = Math.min(startMinutes + length, 1439);
    if (!canDrag(request) || endMinutes <= startMinutes) return;
    const at = (minutes: number) => fromZonedTime(`${request.day}T${formatMinutes(minutes)}:00`, TZ).toISOString();
    void submit({ request, carId, carName, departAt: at(startMinutes), returnAt: at(endMinutes) }, []);
  }

  return {
    canDrag,
    drop,
    saving,
    pending,
    confirm: () => { if (pending) void submit(pending, pending.warnings.map((warning) => warning.code)); },
    cancel: () => setPending(null),
  };
}

/** One line per warning, for the confirmation dialog. */
export function waitingDropWarningText(warning: PlaceWaitingWarning): string {
  if (warning.code === "location") return tv("waitlist.dropWarn.location", { place: warning.place ?? "" });
  if (warning.code === "turnaround") return tv("waitlist.dropWarn.turnaround", { minutes: String(warning.minutes ?? 30) });
  return he.waitlist.dropWarn.luggage;
}
