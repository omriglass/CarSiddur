import { useQuery } from "@tanstack/react-query";
import { useEffect } from "react";

import { FormDialog } from "@/components/FormDialog";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { he } from "@/i18n/he";

import { CalendarAuthError } from "./googleSource";
import type { CalendarInfo } from "./types";
import { useCalendar } from "./useCalendar";
import { useGoogleCalendar } from "./useGoogleCalendar";

interface CalendarDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/**
 * "My calendar" (experimental, owner 2026-10-12), opened from the "my rides" eye menu: connect Google, then tick which
 * calendars show faintly behind the week. Ticks apply at once and are remembered on this device.
 */
export function CalendarDialog({ open, onOpenChange }: CalendarDialogProps) {
  const { source, setSource, selectedCalendarIds, setSelectedCalendarIds } = useCalendar();
  const google = useGoogleCalendar();
  const calendarsQuery = useQuery({
    queryKey: ["calendar", "calendars"],
    queryFn: () => (source as NonNullable<typeof source>).listCalendars(),
    enabled: open && !!source,
    staleTime: 0,
    retry: false,
  });
  const authExpired = calendarsQuery.error instanceof CalendarAuthError;
  useEffect(() => {
    if (authExpired) setSource(null);
  }, [authExpired, setSource]);
  const calendars: CalendarInfo[] | undefined = calendarsQuery.data;
  const failed = calendarsQuery.isError && !authExpired;

  function toggle(id: string, checked: boolean) {
    setSelectedCalendarIds(checked ? [...selectedCalendarIds.filter((x) => x !== id), id] : selectedCalendarIds.filter((x) => x !== id));
  }

  return (
    <FormDialog
      open={open}
      onOpenChange={onOpenChange}
      title={he.calendar.title}
      description={he.calendar.description}
      onSubmit={() => onOpenChange(false)}
      footer={
        <>
          {google.connected ? (
            <Button type="button" variant="outline" onClick={google.disconnect} data-testid="calendar-disconnect">{he.calendar.disconnect}</Button>
          ) : null}
          <Button type="button" onClick={() => onOpenChange(false)}>{he.calendar.close}</Button>
        </>
      }
    >
      <div className="space-y-3" data-testid="calendar-dialog">
        {!google.connected ? (
          <Button type="button" onClick={() => void google.connect()} disabled={google.connecting} data-testid="calendar-connect">
            {he.calendar.connect}
          </Button>
        ) : failed ? (
          <p className="text-sm text-destructive">{he.calendar.loadFailed}</p>
        ) : !calendars ? (
          <p className="text-sm text-muted-foreground">{he.common.loading}</p>
        ) : (
          <ul className="space-y-2">
            {calendars.map((calendar) => (
              <li key={calendar.id} className="flex items-center gap-2">
                <Checkbox
                  id={`calendar-${calendar.id}`}
                  checked={selectedCalendarIds.includes(calendar.id)}
                  onCheckedChange={(checked) => toggle(calendar.id, checked === true)}
                />
                <Label htmlFor={`calendar-${calendar.id}`} className="font-normal">{calendar.name}</Label>
              </li>
            ))}
          </ul>
        )}
        <p className="text-xs text-muted-foreground">{he.calendar.privacy}</p>
      </div>
    </FormDialog>
  );
}
