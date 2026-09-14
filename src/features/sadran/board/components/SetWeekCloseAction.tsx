import { useState, type ReactNode } from "react";
import { differenceInCalendarDays, parseISO } from "date-fns";
import { fromZonedTime } from "date-fns-tz";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { DateField } from "@/components/DateField";
import { FormDialog } from "@/components/FormDialog";
import { TimeField15 } from "@/components/TimeField15";
import { he, tv } from "@/i18n/he";
import { dateKey, formatTime, TZ } from "@/lib/time";

import { useDepartmentSettings, useSetWeekCloseAtMutation, useWeekRow } from "../../hooks";

interface SetWeekCloseActionProps {
  departmentId: string;
  weekStart: string;
  /** The board's kebab "actions" menu passes its own `DropdownMenuItem`; defaults to a plain outline button. */
  renderTrigger?: (props: { onClick: () => void }) => ReactNode;
}

/**
 * F2 (docs/TODO.md 2026-09-14): Sadran-only "change this week's request-closing time"
 * (`set_week_close_at` RPC) — a day picker bounded to `[open_at, publish_at]` plus a
 * `TimeField15`, prefilled with the current `close_at` (both rendered in Asia/Jerusalem via
 * `src/lib/time.ts`, never raw `Date` methods per CLAUDE.md hard rule 6). Rarely used, so it
 * lives behind the board's kebab menu rather than on the main screen — hidden entirely once
 * the week is no longer `open`/`solving` (nothing left to reschedule).
 */
export function SetWeekCloseAction({ departmentId, weekStart, renderTrigger }: SetWeekCloseActionProps) {
  const weekQuery = useWeekRow(departmentId, weekStart);
  const settingsQuery = useDepartmentSettings(departmentId);
  const mutation = useSetWeekCloseAtMutation();
  const [dialogOpen, setDialogOpen] = useState(false);
  const [day, setDay] = useState<string | null>(null);
  const [time, setTime] = useState<string | null>(null);

  const week = weekQuery.data;
  const editable = !!week && (week.phase === "open" || week.phase === "solving");
  if (!editable) return null;

  function openDialog() {
    if (!week) return;
    setDay(dateKey(week.close_at));
    setTime(formatTime(new Date(week.close_at)));
    setDialogOpen(true);
  }

  function handleSubmit() {
    if (!day || !time) return;
    const closeAt = fromZonedTime(`${day}T${time}:00`, TZ).toISOString();
    mutation.mutate(
      { departmentId, weekStart, closeAt },
      { onSuccess: () => { setDialogOpen(false); toast.success(he.weekClose.saved); } },
    );
  }

  const openDay = dateKey(week.open_at);
  const publishDay = dateKey(week.publish_at);
  const dayCount = Math.max(1, differenceInCalendarDays(parseISO(publishDay), parseISO(openDay)) + 1);
  const settings = settingsQuery.data;

  return <>
    {renderTrigger ? renderTrigger({ onClick: openDialog }) : (
      <Button type="button" variant="outline" onClick={openDialog}>{he.weekClose.menuItem}</Button>
    )}
    <FormDialog
      open={dialogOpen}
      onOpenChange={setDialogOpen}
      title={he.weekClose.dialogTitle}
      description={he.weekClose.dialogDescription}
      onSubmit={handleSubmit}
      submitLabel={he.weekClose.confirm}
      loading={mutation.isPending}
      submitDisabled={!day || !time}
    >
      <div className="space-y-3">
        <div className="space-y-1">
          <p className="text-sm font-medium">{he.weekClose.dayLabel}</p>
          <DateField weekStart={openDay} dayCount={dayCount} value={day ?? ""} onChange={setDay} ariaLabel={he.weekClose.dayLabel} />
        </div>
        <div className="space-y-1">
          <p className="text-sm font-medium">{he.weekClose.timeLabel}</p>
          <TimeField15 value={time ?? "12:00"} onChange={setTime} aria-label={he.weekClose.timeLabel} />
        </div>
        {settings ? (
          <p className="text-xs text-muted-foreground">
            {tv("weekClose.defaultHint", { day: he.days.long[settings.close_dow] ?? "", time: settings.close_time.slice(0, 5) })}
          </p>
        ) : null}
      </div>
    </FormDialog>
  </>;
}
