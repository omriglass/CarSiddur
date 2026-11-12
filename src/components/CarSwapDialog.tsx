import { useState } from "react";
import { toast } from "sonner";

import { ConfirmDialog } from "@/components/ConfirmDialog";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { carSwapBlockerMessage, carSwapRideLabel } from "@/features/carSwap/blockerMessages";
import { carSwapAskedForCar, carSwapConfirmDisabled, carSwapFromOptions, carSwapSeriesRangeLabel, groupCarSwapRidesByCar } from "@/features/carSwap/dialogView";
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
  /** The board records the swap for its undo (TODO UN1); the siddur has none. */
  recordUndo?: <T>(action: () => Promise<T>) => Promise<T>;
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
export function CarSwapDialog({ open, onOpenChange, departmentId, weekStart, day, carA, carB, recordUndo = (action) => action() }: CarSwapDialogProps) {
  const [seriesMode, setSeriesMode] = useState<CarSwapSeriesMode>("whole");
  // REQ §13.180: swap only the rides starting at or after this hour (`HH:mm`); null = the whole day.
  const [from, setFrom] = useState<string | null>(null);
  // Resets the one-off UI choice for a fresh open/pair — the React-sanctioned "adjust state
  // during render" pattern (react.dev "You Might Not Need an Effect"), not a `useEffect`, so
  // there is no extra render between the pair changing and the radio resetting.
  const [resetKey, setResetKey] = useState<string | null>(null);
  const openKey = open ? `${carA.id}:${carB.id}:${day}` : null;
  if (open && openKey !== resetKey) {
    setResetKey(openKey);
    setSeriesMode("whole");
    setFrom(null);
  }

  const previewArgs: CarSwapArgs | null = open ? { departmentId, weekStart, day, carA: carA.id, carB: carB.id } : null;
  // The whole day's preview always runs: its rides give the hours to swap from.
  const dayPreviewQuery = useCarSwapPreviewQuery(previewArgs);
  const fromPreviewQuery = useCarSwapPreviewQuery(previewArgs && from ? { ...previewArgs, from } : null);
  const previewQuery = from ? fromPreviewQuery : dayPreviewQuery;
  const mutation = useCarSwapMutation();
  const fromOptions = carSwapFromOptions(dayPreviewQuery.data?.rides ?? []);

  const preview = previewQuery.data;
  const staying = preview?.staying ?? [];
  // A series leg colliding with the target car on another day (REQ §13.92, 2026-10-16) leaves only "day".
  const effectiveMode: CarSwapSeriesMode = preview?.whole_blocked ? "day" : seriesMode;
  const carNameById: Record<string, string> = { [carA.id]: carA.name, [carB.id]: carB.name };
  const groups = preview ? groupCarSwapRidesByCar(preview.rides, carA, carB) : [];
  // REQ §13.186: other days' rides the "whole" mode pulls in; blockers may name them too.
  const chain = preview?.chain ?? [];
  const labelRides = preview ? [...preview.rides, ...chain] : [];
  // SW2 (REQ item 213): people on the rides that move who asked for their current car specifically.
  const askedForCar = preview ? carSwapAskedForCar(effectiveMode === "whole" ? labelRides : preview.rides) : [];

  async function handleConfirm() {
    if (!preview) return;
    try {
      const result = await recordUndo(() => mutation.mutateAsync({
        departmentId, weekStart, day, carA: carA.id, carB: carB.id,
        expectedFingerprint: preview.fingerprint,
        seriesMode: effectiveMode,
        from,
        skipSeats: staying.length > 0,
        allowShortTurnaround: preview.needs_short_turnaround === true,
      }));
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

  const hardBlockers = preview?.blockers.filter((blocker) => !blocker.waivable && !blocker.whole_only && !blocker.short_turnaround) ?? [];
  // REQ §13.186 (2026-11-08): rides coming closer than the turnaround — shown, and confirming the swap accepts them.
  const shortTurnarounds = preview?.blockers.filter((blocker) => blocker.short_turnaround) ?? [];
  const wholeOnlyBlockers = preview?.blockers.filter((blocker) => blocker.whole_only) ?? [];
  const waivableBlockers = preview?.blockers.filter((blocker) => blocker.waivable) ?? [];

  return (
    <ConfirmDialog
      open={open}
      onOpenChange={onOpenChange}
      title={tv("carSwap.dialogTitle", { carA: carA.name, carB: carB.name })}
      description={tv("carSwap.dialogDay", { day: formatDayDate(day) })}
      confirmDisabled={carSwapConfirmDisabled(preview, effectiveMode) || mutation.isPending}
      loading={mutation.isPending}
      onConfirm={() => void handleConfirm()}
    >
      <div className="max-h-[50dvh] space-y-3 overflow-y-auto text-sm">
        {fromOptions.length > 0 ? (
          <label className="flex items-center justify-between gap-2">
            <span className="font-medium">{he.carSwap.fromLabel}</span>
            <Select value={from ?? "day"} onValueChange={(value) => setFrom(value === "day" ? null : value)}>
              <SelectTrigger className="w-32" data-testid="car-swap-from" aria-label={he.carSwap.fromLabel}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="day">{he.carSwap.fromWholeDay}</SelectItem>
                {fromOptions.map((time) => <SelectItem key={time} value={time}>{tv("carSwap.fromTime", { time })}</SelectItem>)}
              </SelectContent>
            </Select>
          </label>
        ) : null}
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
                        <span className="truncate">{carSwapRideLabel(ride)}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              ) : null,
            )}

            {staying.length > 0 ? (
              <div className="space-y-1 rounded-md border border-amber-500/50 bg-amber-500/5 p-2" data-testid="car-swap-staying">
                <p className="font-medium">{he.carSwap.stayingTitle}</p>
                <ul className="space-y-1 text-xs">
                  {staying.map((ride) => (
                    <li key={ride.ride_id} className="flex items-center justify-between gap-2">
                      <span dir="ltr">{formatTime(new Date(ride.starts_at))}–{formatTime(new Date(ride.ends_at))}</span>
                      <span className="truncate">{carSwapRideLabel(ride)}</span>
                    </li>
                  ))}
                </ul>
                <p className="text-xs text-muted-foreground">{he.carSwap.stayingConfirm}</p>
              </div>
            ) : null}

            {askedForCar.length > 0 ? (
              <p className="rounded-md border border-amber-500/50 bg-amber-500/5 p-2" role="alert" data-testid="car-swap-asked-for-car">
                {tv("carSwap.askedForCar", { names: askedForCar.join(", ") })}
              </p>
            ) : null}

            {chain.length > 0 && effectiveMode === "whole" ? (
              <div className="space-y-1 rounded-md border p-2 text-sm" data-testid="car-swap-chain">
                <p className="font-medium">
                  {tv("carSwap.chainSummary", { rides: String(preview.chain_rides ?? chain.length), days: String(preview.chain_days ?? 0) })}
                </p>
                <ul className="space-y-0.5">
                  {chain.map((ride) => (
                    <li key={ride.ride_id}>
                      {formatDayDate(ride.starts_at)}{" "}
                      <span dir="ltr">{formatTime(new Date(ride.starts_at))}–{formatTime(new Date(ride.ends_at))}</span>{" "}
                      {carSwapRideLabel(ride)} · {carNameById[ride.car_id] ?? ""} ←{" "}
                      {carNameById[ride.car_id === carA.id ? carB.id : carA.id]}
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
            {preview.series.length > 0 ? (
              <div className="space-y-2 rounded-md border p-2" data-testid="car-swap-series-choice">
                <p className="font-medium">{he.carSwap.seriesQuestion}</p>
                <RadioGroup value={effectiveMode} onValueChange={(value) => setSeriesMode(value as CarSwapSeriesMode)} className="gap-2">
                  <label className="flex min-h-11 items-center gap-2 rounded-md border p-2 text-sm">
                    <RadioGroupItem value="whole" disabled={preview.whole_blocked === true} />
                    {tv("carSwap.seriesWhole", { range: carSwapSeriesRangeLabel(preview.series) })}
                  </label>
                  <label className="flex min-h-11 items-center gap-2 rounded-md border p-2 text-sm">
                    <RadioGroupItem value="day" />
                    {he.carSwap.seriesDayOnly}
                  </label>
                </RadioGroup>
                {wholeOnlyBlockers.map((blocker, index) => (
                  <p key={index} className="text-xs text-destructive" data-testid="car-swap-whole-blocked">
                    {carSwapBlockerMessage(blocker, labelRides, carNameById)}
                  </p>
                ))}
              </div>
            ) : null}

            {hardBlockers.length > 0 ? (
              <div className="space-y-1 rounded-md border border-destructive/50 bg-destructive/5 p-2" data-testid="car-swap-blockers">
                <p className="font-medium text-destructive">{he.carSwap.blockersTitle}</p>
                <ul className="space-y-1 text-xs text-destructive">
                  {hardBlockers.map((blocker, index) => (
                    <li key={index}>{carSwapBlockerMessage(blocker, labelRides, carNameById)}</li>
                  ))}
                </ul>
              </div>
            ) : null}

            {waivableBlockers.length > 0 ? (
              <div className="space-y-1 rounded-md border border-amber-500/50 bg-amber-500/5 p-2" data-testid="car-swap-waivable">
                <p className="font-medium">{he.smallTrunk.confirmTitle}</p>
                <ul className="space-y-1 text-xs">
                  {waivableBlockers.map((blocker, index) => (
                    <li key={index}>{carSwapBlockerMessage(blocker, labelRides, carNameById)}</li>
                  ))}
                </ul>
              </div>
            ) : null}

            {shortTurnarounds.length > 0 ? (
              <div className="space-y-1 rounded-md border border-amber-500/50 bg-amber-500/5 p-2" data-testid="car-swap-short-turnaround">
                <p className="font-medium">{he.carSwap.shortTurnaroundTitle}</p>
                <ul className="space-y-1 text-xs">
                  {shortTurnarounds.map((blocker, index) => (
                    <li key={index}>{carSwapBlockerMessage(blocker, labelRides, carNameById)}</li>
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
