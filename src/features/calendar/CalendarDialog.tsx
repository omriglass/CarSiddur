import { useQuery } from "@tanstack/react-query";
import { useEffect } from "react";

import { FormDialog } from "@/components/FormDialog";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { Slider } from "@/components/ui/slider";
import { Switch } from "@/components/ui/switch";
import { he } from "@/i18n/he";

import { CalendarAuthError } from "./googleSource";
import type { CalendarDisplayPrefs } from "./displayPrefs";
import type { CalendarInfo } from "./types";
import { useCalendar } from "./useCalendar";
import { useGoogleCalendar } from "./useGoogleCalendar";

interface CalendarDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/**
 * "My calendar" (experimental, owner 2026-10-12), opened from the calendar button beside the "my rides" eye menu: connect Google
 * (or, in dev builds, the sample calendar), tick which calendars show faintly behind the week, which fields and whether
 * the original colors are used. Everything applies at once and is remembered on this device.
 */
export function CalendarDialog({ open, onOpenChange }: CalendarDialogProps) {
  const { source, setSource, selectedCalendarIds, setSelectedCalendarIds, displayPrefs, setDisplayPrefs } = useCalendar();
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

  function setPref(key: Exclude<keyof CalendarDisplayPrefs, "itemVisibility">, value: boolean) {
    setDisplayPrefs({ ...displayPrefs, [key]: value });
  }

  const fieldOptions = [
    { key: "hours", label: he.calendar.fieldHours },
    { key: "location", label: he.calendar.fieldLocation },
    { key: "participants", label: he.calendar.fieldParticipants },
    { key: "notes", label: he.calendar.fieldNotes },
  ] as const;

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
          <div className="space-y-2">
            {google.googleAvailable ? (
              <Button type="button" onClick={() => void google.connect()} disabled={google.connecting} data-testid="calendar-connect">
                {he.calendar.connect}
              </Button>
            ) : null}
            {google.sampleAvailable ? (
              <div className="space-y-1">
                <Button type="button" variant="outline" onClick={google.connectSample} data-testid="calendar-sample">
                  {he.calendar.useSample}
                </Button>
                <p className="text-xs text-muted-foreground">{he.calendar.sampleHint}</p>
              </div>
            ) : null}
          </div>
        ) : (
          <>
            <section className="space-y-2">
              <h3 className="text-sm font-medium">{he.calendar.calendarsHeading}</h3>
              {failed ? (
                <p className="text-sm text-destructive">{he.calendar.loadFailed}</p>
              ) : !calendars ? (
                <p className="text-sm text-muted-foreground">{he.common.loading}</p>
              ) : (
                <ul className="space-y-2">
                  {calendars.map((calendar) => (
                    <li key={calendar.id} className="flex min-h-11 items-center gap-2">
                      <Checkbox
                        id={`calendar-${calendar.id}`}
                        checked={selectedCalendarIds.includes(calendar.id)}
                        onCheckedChange={(checked) => toggle(calendar.id, checked === true)}
                      />
                      {calendar.color ? <span className="size-3 shrink-0 rounded-full" style={{ backgroundColor: calendar.color }} aria-hidden="true" /> : null}
                      <Label htmlFor={`calendar-${calendar.id}`} className="font-normal">{calendar.name}</Label>
                    </li>
                  ))}
                </ul>
              )}
            </section>
            <section className="space-y-2" data-testid="calendar-display-options">
              <h3 className="text-sm font-medium">{he.calendar.fieldsHeading}</h3>
              <p className="text-xs text-muted-foreground">{he.calendar.fieldsHint}</p>
              <ul className="space-y-2">
                {fieldOptions.map((option) => (
                  <li key={option.key} className="flex min-h-11 items-center gap-2">
                    <Checkbox
                      id={`calendar-field-${option.key}`}
                      data-testid={`calendar-field-${option.key}`}
                      checked={displayPrefs[option.key]}
                      onCheckedChange={(checked) => setPref(option.key, checked === true)}
                    />
                    <Label htmlFor={`calendar-field-${option.key}`} className="font-normal">{option.label}</Label>
                  </li>
                ))}
              </ul>
              <div className="flex min-h-11 items-center justify-between gap-3">
                <div>
                  <Label htmlFor="calendar-use-colors">{he.calendar.useColors}</Label>
                  <p className="text-xs text-muted-foreground">{he.calendar.useColorsHint}</p>
                </div>
                <Switch id="calendar-use-colors" data-testid="calendar-use-colors" checked={displayPrefs.useCalendarColors} onCheckedChange={(checked) => setPref("useCalendarColors", checked)} />
              </div>
              {/* Owner 2026-10-12, "visibility aid": fade my rides / requests so the events behind them show. */}
              <div className="space-y-2 pt-1" data-testid="calendar-visibility-aid">
                <Label id="calendar-visibility-aid-label">{he.calendar.visibilityAid}</Label>
                <p className="text-xs text-muted-foreground">{he.calendar.visibilityAidHint}</p>
                <Slider
                  aria-labelledby="calendar-visibility-aid-label"
                  min={0}
                  max={100}
                  step={10}
                  value={[displayPrefs.itemVisibility]}
                  onValueChange={([value]) => { if (value !== undefined) setDisplayPrefs({ ...displayPrefs, itemVisibility: value }); }}
                />
                {/* The slider's start (right in RTL) is the see-through end. */}
                <div className="flex justify-between text-xs text-muted-foreground">
                  <span>{he.calendar.visibilityAidClear}</span>
                  <button type="button" className="underline-offset-2 hover:underline" onClick={() => setDisplayPrefs({ ...displayPrefs, itemVisibility: 50 })}>{he.calendar.visibilityAidReset}</button>
                  <span>{he.calendar.visibilityAidSolid}</span>
                </div>
              </div>
            </section>
          </>
        )}
        <p className="text-xs text-muted-foreground">{he.calendar.privacy}</p>
      </div>
    </FormDialog>
  );
}
