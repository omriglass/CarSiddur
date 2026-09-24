// Extracted from `RequestForm.tsx` (docs/TODO.md "Code review 2026-09-24" R9):
// the day/return-day picker (REQ §13.77 multi-day "series") and trip-shape
// control — grouped together since both toggle off the same `isMultiDay`
// state. Pure move — behaviour and markup unchanged.
import { Controller, type Control, type UseFormReturn } from "react-hook-form";

import { Button } from "@/components/ui/button";
import { FormItem } from "@/components/ui/form";
import { Label } from "@/components/ui/label";
import { DateField } from "@/components/DateField";
import { datesOfWeek } from "@/components/dateFieldDates";
import { FieldAnchor } from "@/components/FieldAnchor";
import { TripShapeControl } from "@/components/TripShapeControl";
import { t, tv } from "@/i18n/he";

import { returnDayAfterDayChange } from "../../series";
import type { RequestFormValues } from "../../schema";

export interface DayAndTripShapeFieldsProps {
  control: Control<RequestFormValues>;
  form: UseFormReturn<RequestFormValues>;
  weekStart: string;
  variant: "weekly" | "quick" | "carNow";
  showReturnDayPicker: boolean;
  returnAnotherDay: boolean;
  setReturnAnotherDay: (open: boolean) => void;
  day: string;
  isMultiDay: boolean;
  multiDaySpan: number | null;
  isQuickContext: boolean;
  oneWay: boolean;
}

export function DayAndTripShapeFields({
  control,
  form,
  weekStart,
  variant,
  showReturnDayPicker,
  returnAnotherDay,
  setReturnAnotherDay,
  day,
  isMultiDay,
  multiDaySpan,
  isQuickContext,
  oneWay,
}: DayAndTripShapeFieldsProps) {
  return (
    <>
      {variant !== "carNow" ? (
        <FormItem data-field="day">
          <Label>{t("field.day")}</Label>
          <Controller
            control={control}
            name="day"
            render={({ field }) => (
              <DateField
                weekStart={weekStart}
                value={field.value}
                onChange={(next) => {
                  field.onChange(next);
                  form.setValue("dayIndex", Math.max(datesOfWeek(weekStart).indexOf(next), 0));
                  // The return day follows the departure day unless the member opened the
                  // "return another day" picker (`returnDayAfterDayChange`, TODO B1 2026-09-14).
                  const nextReturnDay = returnDayAfterDayChange({
                    pickerOpen: returnAnotherDay, currentReturnDay: form.getValues("returnDay"), nextDay: next,
                  });
                  if (nextReturnDay !== form.getValues("returnDay")) {
                    form.setValue("returnDay", nextReturnDay, { shouldDirty: true });
                  }
                }}
              />
            )}
          />
        </FormItem>
      ) : null}

      {showReturnDayPicker && !returnAnotherDay ? (
        <Button
          type="button"
          variant="link"
          size="sm"
          className="h-auto self-start px-0 text-xs"
          onClick={() => setReturnAnotherDay(true)}
        >
          {t("request.returnAnotherDay")}
        </Button>
      ) : null}
      {showReturnDayPicker && returnAnotherDay ? (
        <FormItem data-field="returnDay">
          <div className="flex items-center justify-between gap-2">
            <Label>{t("request.returnDay")}</Label>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="h-auto px-1 text-xs"
              onClick={() => {
                form.setValue("returnDay", day, { shouldDirty: true });
                setReturnAnotherDay(false);
              }}
            >
              {t("request.returnSameDay")}
            </Button>
          </div>
          <Controller
            control={control}
            name="returnDay"
            render={({ field }) => (
              <DateField
                weekStart={day}
                value={field.value ?? day}
                onChange={field.onChange}
                dayCount={14}
                ariaLabel={t("request.returnDay")}
              />
            )}
          />
        </FormItem>
      ) : null}
      {isMultiDay ? (
        <div className="space-y-1 rounded-md border-s-4 border-primary bg-primary/5 p-3 text-sm">
          <p>{t("request.multiDayHint")}</p>
          {multiDaySpan ? <p className="text-xs text-muted-foreground">{tv("request.multiDayBadge", { count: String(multiDaySpan) })}</p> : null}
        </div>
      ) : null}

      {variant !== "carNow" && !isMultiDay ? (
        <FieldAnchor name="tripShape">
          <Controller
            control={control}
            name="tripShape"
            render={({ field }) => (
              <TripShapeControl
                value={field.value}
                onChange={(next) => {
                  const previousShape = field.value;
                  field.onChange(next);
                  // `departTime`/`returnTime` are two independent fields, but only one is ever
                  // shown for a one-way shape — carry the visible value across so switching shape
                  // doesn't silently swap in the other field's own (possibly stale) value.
                  if (next === "one_way_from" && previousShape !== "one_way_from") {
                    form.setValue("returnTime", form.getValues("departTime"), { shouldDirty: true });
                  } else if (previousShape === "one_way_from" && next !== "one_way_from") {
                    form.setValue("departTime", form.getValues("returnTime"), { shouldDirty: true });
                  }
                }}
              />
            )}
          />
          {isQuickContext && oneWay ? <p className="text-sm text-destructive">{t("quickRequest.oneWayHelp")}</p> : null}
        </FieldAnchor>
      ) : null}
    </>
  );
}
