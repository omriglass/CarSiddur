import { addDays } from "date-fns";
import { fromZonedTime, formatInTimeZone } from "date-fns-tz";
import { useState } from "react";
import { toast } from "sonner";

import { FormDialog } from "@/components/FormDialog";
import { TimeField15 } from "@/components/TimeField15";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { he, tv } from "@/i18n/he";
import { dateKey, TZ } from "@/lib/time";

import {
  useCreateCarMaintenanceMutation,
  useDeleteCarMaintenanceMutation,
  useMarkIssueUnsafeMaintenanceMutation,
  useUpdateCarMaintenanceMutation,
} from "../hooks";

import type { MaintenancePeriod } from "../maintenance";

export type MaintenancePeriodDialogTarget =
  | { mode: "create"; carId: string; carName: string }
  | { mode: "edit"; carName: string; block: MaintenancePeriod }
  /** From a car issue (REQ §13.114): the period starts now, only the end is chosen. */
  | { mode: "unsafe"; carName: string; issueId: string };

interface Props {
  target: MaintenancePeriodDialogTarget | null;
  onOpenChange: (open: boolean) => void;
}

function toIso(date: string, time: string): string {
  return fromZonedTime(`${date}T${time}:00`, TZ).toISOString();
}

function initialFields(target: MaintenancePeriodDialogTarget) {
  if (target.mode === "edit") {
    const start = new Date(target.block.starts_at);
    const end = new Date(target.block.ends_at);
    return {
      fromDate: dateKey(start), fromTime: formatInTimeZone(start, TZ, "HH:mm"),
      toDate: dateKey(end), toTime: formatInTimeZone(end, TZ, "HH:mm"),
    };
  }
  const now = new Date();
  const today = dateKey(now);
  if (target.mode === "unsafe") return { fromDate: today, fromTime: "00:00", toDate: dateKey(addDays(now, 1)), toTime: "17:00" };
  return { fromDate: today, fromTime: "08:00", toDate: today, toTime: "17:00" };
}

/**
 * The "תקופת טיפול" dialog (REQ §13.114): start date + time, end date + time (may span days), from the car page,
 * the car issue screen (unsafe: start = now) and the grid band's click (edit / remove). The server snaps to
 * quarter hours and re-checks who may do this.
 */
export function MaintenancePeriodDialog({ target, onOpenChange }: Props) {
  // Re-mounted per target (key) so the fields start from the target's values.
  return target ? <DialogBody key={target.mode === "edit" ? target.block.id : `${target.mode}-${target.carName}`} target={target} onOpenChange={onOpenChange} /> : null;
}

function DialogBody({ target, onOpenChange }: { target: MaintenancePeriodDialogTarget; onOpenChange: (open: boolean) => void }) {
  const [initial] = useState(() => initialFields(target));
  const [today] = useState(() => dateKey(new Date()));
  const [fromDate, setFromDate] = useState(initial.fromDate);
  const [fromTime, setFromTime] = useState(initial.fromTime);
  const [toDate, setToDate] = useState(initial.toDate);
  const [toTime, setToTime] = useState(initial.toTime);
  const [reason, setReason] = useState("");
  const [confirmRemove, setConfirmRemove] = useState(false);
  const createMutation = useCreateCarMaintenanceMutation();
  const updateMutation = useUpdateCarMaintenanceMutation();
  const deleteMutation = useDeleteCarMaintenanceMutation();
  const unsafeMutation = useMarkIssueUnsafeMaintenanceMutation();
  const loading = createMutation.isPending || updateMutation.isPending || deleteMutation.isPending || unsafeMutation.isPending;

  const isUnsafe = target.mode === "unsafe";
  const endsAt = toDate && toTime ? toIso(toDate, toTime) : "";
  const startsAt = fromDate && fromTime ? toIso(fromDate, fromTime) : "";
  const invalid = !endsAt || (!isUnsafe && (!startsAt || Date.parse(endsAt) <= Date.parse(startsAt)));

  const title = target.mode === "edit" ? he.maintenancePeriod.titleEdit : isUnsafe ? he.maintenancePeriod.titleUnsafe : he.maintenancePeriod.title;

  async function submit() {
    if (invalid) return;
    try {
      if (target.mode === "create") {
        await createMutation.mutateAsync({ carId: target.carId, startsAt, endsAt, reason: reason.trim() || undefined });
      } else if (target.mode === "edit") {
        const result = await updateMutation.mutateAsync({ blockId: target.block.id, startsAt, endsAt });
        if (result.flagged_rides > 0) toast.warning(tv("maintenancePeriod.flaggedToast", { count: String(result.flagged_rides) }));
      } else {
        await unsafeMutation.mutateAsync({ issueId: target.issueId, endsAt });
      }
      toast.success(he.maintenancePeriod.savedToast);
      onOpenChange(false);
    } catch {
      // the mutation's onError already toasted the mapped message
    }
  }

  async function remove() {
    if (target.mode !== "edit") return;
    if (!confirmRemove) {
      setConfirmRemove(true);
      return;
    }
    try {
      await deleteMutation.mutateAsync(target.block.id);
      toast.success(he.maintenancePeriod.removedToast);
      onOpenChange(false);
    } catch {
      // toasted by onError
    }
  }

  return (
    <FormDialog
      open
      onOpenChange={onOpenChange}
      title={`${title} · ${target.carName}`}
      description={target.mode === "edit" ? he.maintenancePeriod.dragHint : undefined}
      loading={loading}
      onSubmit={submit}
      submitDisabled={invalid}
      submitLabel={he.maintenancePeriod.save}
      footer={
        <>
          {target.mode === "edit" ? (
            <Button type="button" variant="destructive" className="w-full sm:me-auto sm:w-auto" disabled={loading} onClick={remove} data-testid="maintenance-remove">
              {confirmRemove ? he.maintenancePeriod.removeConfirm : he.maintenancePeriod.remove}
            </Button>
          ) : null}
          <Button type="button" variant="outline" className="w-full sm:w-auto" disabled={loading} onClick={() => onOpenChange(false)}>
            {he.common.cancel}
          </Button>
          <Button type="button" className="w-full sm:w-auto" disabled={loading || invalid} onClick={submit} data-testid="maintenance-save">
            {he.maintenancePeriod.save}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        <div className="flex items-end gap-2">
          <label className="flex min-w-0 flex-1 flex-col gap-1 text-sm">
            {he.maintenancePeriod.from}
            {isUnsafe ? (
              <span className="flex h-9 items-center rounded-md border bg-muted px-3 text-muted-foreground">{he.maintenancePeriod.fromNow}</span>
            ) : (
              <Input type="date" dir="ltr" value={fromDate} onChange={(e) => setFromDate(e.target.value)} data-testid="maintenance-from-date" />
            )}
          </label>
          {isUnsafe ? null : <TimeField15 value={fromTime} min="00:00" onChange={setFromTime} aria-label={he.maintenancePeriod.from} />}
        </div>
        <div className="flex items-end gap-2">
          <label className="flex min-w-0 flex-1 flex-col gap-1 text-sm">
            {he.maintenancePeriod.to}
            <Input type="date" dir="ltr" value={toDate} min={today} onChange={(e) => setToDate(e.target.value)} data-testid="maintenance-to-date" />
          </label>
          <TimeField15 value={toTime} min="00:00" onChange={setToTime} aria-label={he.maintenancePeriod.to} />
        </div>
        {target.mode === "create" ? (
          <label className="flex flex-col gap-1 text-sm">
            {he.maintenancePeriod.reason}
            <Input value={reason} maxLength={200} onChange={(e) => setReason(e.target.value)} />
          </label>
        ) : null}
        {invalid && (toDate || toTime) ? <p className="text-sm text-destructive">{he.maintenancePeriod.errors.invalid}</p> : null}
      </div>
    </FormDialog>
  );
}
