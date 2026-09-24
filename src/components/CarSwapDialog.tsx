import { useState } from "react";
import { toast } from "sonner";

import { ConfirmDialog } from "@/components/ConfirmDialog";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { carSwapBlockerMessage } from "@/features/carSwap/blockerMessages";
import { carSwapConfirmDisabled, carSwapSeriesRangeLabel, groupCarSwapRidesByCar } from "@/features/carSwap/dialogView";
import { useCarSwapMutation, useCarSwapPreviewQuery } from "@/features/carSwap/hooks";
import { he, tv } from "@/i18n/he";
import { formatDayDate } from "@/lib/dayLabels";
import { showErrorToast, toAppError } from "@/lib/rpc";
import { formatTime } from "@/lib/time";

import type { CarSwapArgs } from "@/features/carSwap/api";
import type { CarSwapSeriesMode } from "@/features/carSwap/schema";

interface CarSwapDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  departmentId: string;
  weekStart: string;
  /** `yyyy-MM-dd` — the day the `WeekGrid` instance that opened this dialog is showing. */
  day: string;
  carA: { id: string; name: string };
  carB: { id: string; name: string };
}

/**
 * Swap cars on a day by dragging car names (REQ §13.92, owner batch
 * 2026-09-24 S1). Shared by the Sadran board and the member siddur grid —
 * lives in `src/components/` (not inside either feature) so both can import
 * it; its own data access goes through the `carSwap` feature's
 * `api.ts`/`hooks.ts`/`keys.ts` (CLAUDE.md "Structure"). The caller decides
 * *whether* the swap is allowed here (published/non-past for a member,
 * non-archived for a Sadran, REQ §13.92 "Who") — this dialog only previews
 * and confirms whatever pair of cars/day it is given.
 */
export function CarSwapDialog({ open, onOpenChange, departmentId, weekStart, day, carA, carB }: CarSwapDialogProps) {
  const [seriesMode, setSeriesMode] = useState<CarSwapSeriesMode>("whole");
  // Resets the one-off UI choice for a fresh open/pair — the React-sanctioned "adjust state
  // during render" pattern (react.dev "You Might Not Need an Effect"), not a `useEffect`, so
  // there is no extra render between the pair changing and the radio resetting.
  const [resetKey, setResetKey] = useState<string | null>(null);
  const openKey = open ? `${carA.id}:${carB.id}:${day}` : null;
  if (open && openKey !== resetKey) {
    setResetKey(openKey);
    setSeriesMode("whole");
  }

  const previewArgs: CarSwapArgs | null = open ? { departmentId, weekStart, day, carA: carA.id, carB: carB.id } : null;
  const previewQuery = useCarSwapPreviewQuery(previewArgs);
  const mutation = useCarSwapMutation();

  const preview = previewQuery.data;
  const carNameById: Record<string, string> = { [carA.id]: carA.name, [carB.id]: carB.name };
  const groups = preview ? groupCarSwapRidesByCar(preview.rides, carA, carB) : [];

  async function handleConfirm() {
    if (!preview) return;
    try {
      const result = await mutation.mutateAsync({
        departmentId, weekStart, day, carA: carA.id, carB: carB.id,
        expectedFingerprint: preview.fingerprint,
        seriesMode,
      });
      toast.success(he.carSwap.successToast);
      if (result.notified > 0) toast(tv("carSwap.notifiedToast", { count: String(result.notified) }));
      for (const notice of result.notices) {
        toast(tv("carSwap.noticeEndsAway", { car: carNameById[notice.car_id] ?? "", place: notice.location_name }));
      }
      onOpenChange(false);
    } catch (error) {
      showErrorToast(error);
    }
  }

  return (
    <ConfirmDialog
      open={open}
      onOpenChange={onOpenChange}
      title={tv("carSwap.dialogTitle", { carA: carA.name, carB: carB.name })}
      description={tv("carSwap.dialogDay", { day: formatDayDate(day) })}
      confirmDisabled={carSwapConfirmDisabled(preview) || mutation.isPending}
      loading={mutation.isPending}
      onConfirm={() => void handleConfirm()}
    >
      <div className="max-h-[50dvh] space-y-3 overflow-y-auto text-sm">
        {previewQuery.isLoading ? <p className="text-muted-foreground">{he.common.loading}</p> : null}
        {previewQuery.isError ? <p className="text-destructive">{toAppError(previewQuery.error).message}</p> : null}
        {preview ? (
          <>
            {preview.rides.length > 0 ? (
              <p className="font-medium">{tv("carSwap.movedCount", { count: String(preview.rides.length) })}</p>
            ) : (
              <p className="text-muted-foreground">{he.carSwap.noRidesToMove}</p>
            )}

            {groups.map((group) =>
              group.rides.length > 0 ? (
                <div key={group.carId} data-testid={`car-swap-group-${group.carId}`}>
                  <p className="font-medium">{tv("carSwap.fromCarHeading", { car: group.carName })}</p>
                  <ul className="mt-1 space-y-1">
                    {group.rides.map((ride) => (
                      <li key={ride.ride_id} className="flex items-center justify-between gap-2 text-xs">
                        <span dir="ltr">{formatTime(new Date(ride.starts_at))}–{formatTime(new Date(ride.ends_at))}</span>
                        <span className="truncate">{ride.label ?? ride.driver_name ?? "—"}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              ) : null,
            )}

            {preview.series.length > 0 ? (
              <div className="space-y-2 rounded-md border p-2" data-testid="car-swap-series-choice">
                <p className="font-medium">{he.carSwap.seriesQuestion}</p>
                <RadioGroup value={seriesMode} onValueChange={(value) => setSeriesMode(value as CarSwapSeriesMode)} className="gap-2">
                  <label className="flex min-h-11 items-center gap-2 rounded-md border p-2 text-sm">
                    <RadioGroupItem value="whole" />
                    {tv("carSwap.seriesWhole", { range: carSwapSeriesRangeLabel(preview.series) })}
                  </label>
                  <label className="flex min-h-11 items-center gap-2 rounded-md border p-2 text-sm">
                    <RadioGroupItem value="day" />
                    {he.carSwap.seriesDayOnly}
                  </label>
                </RadioGroup>
              </div>
            ) : null}

            {preview.blockers.length > 0 ? (
              <div className="space-y-1 rounded-md border border-destructive/50 bg-destructive/5 p-2" data-testid="car-swap-blockers">
                <p className="font-medium text-destructive">{he.carSwap.blockersTitle}</p>
                <ul className="space-y-1 text-xs text-destructive">
                  {preview.blockers.map((blocker, index) => (
                    <li key={index}>{carSwapBlockerMessage(blocker, preview.rides, carNameById)}</li>
                  ))}
                </ul>
              </div>
            ) : null}

            {preview.notices.length > 0 ? (
              <ul className="space-y-1 text-xs text-muted-foreground">
                {preview.notices.map((notice) => (
                  <li key={notice.car_id}>{tv("carSwap.noticeEndsAway", { car: carNameById[notice.car_id] ?? "", place: notice.location_name })}</li>
                ))}
              </ul>
            ) : null}
          </>
        ) : null}
      </div>
    </ConfirmDialog>
  );
}
