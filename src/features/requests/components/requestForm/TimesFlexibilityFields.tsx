// Extracted from `RequestForm.tsx` (docs/TODO.md "Code review 2026-09-24" R9):
// the depart/return time fields (plus the quick-variant free-car warning and
// "car at destination" toggle) and the flexibility-range fields — two
// components since they sit apart in the original markup (times near the
// top, flexibility after passengers/luggage), both still "times+flexibility"
// in concern. Pure move — behaviour and markup unchanged.
import { Controller, type UseFormReturn } from "react-hook-form";

import { Button } from "@/components/ui/button";
import { FormItem } from "@/components/ui/form";
import { Label } from "@/components/ui/label";
import { CarAtDestinationToggle } from "@/components/CarAtDestinationToggle";
import { FieldAnchor } from "@/components/FieldAnchor";
import { FlexibilityRange } from "@/components/FlexibilitySegmented";
import { TimeField15 } from "@/components/TimeField15";
import { t, tv } from "@/i18n/he";
import { formatTime } from "@/lib/time";

import { shiftReturnByDepartureDelta } from "../../duration";
import type { RequestFormValues } from "../../schema";
import { FieldError } from "./FieldError";

export interface TimeFieldsProps {
  form: UseFormReturn<RequestFormValues>;
  variant: "weekly" | "quick" | "carNow";
  tripShape: RequestFormValues["tripShape"];
  isQuickContext: boolean;
  oneWay: boolean;
  startMs: number;
  endMs: number;
  carIsFree: boolean;
  isAway: boolean;
  otherFreeCar: { id: string; name: string } | undefined;
  departTimeError: string | undefined;
  returnTimeError: string | undefined;
}

export function TimeFields({
  form,
  variant,
  tripShape,
  isQuickContext,
  oneWay,
  startMs,
  endMs,
  carIsFree,
  isAway,
  otherFreeCar,
  departTimeError,
  returnTimeError,
}: TimeFieldsProps) {
  const { control } = form;
  return (
    <>
      <div className="flex gap-4">
        {variant !== "carNow" && tripShape !== "one_way_from" ? (
          <FormItem className="flex-1" data-field="departTime">
            <Label>{t("field.depart")}</Label>
            <Controller
              control={control}
              name="departTime"
              render={({ field }) => (
                <TimeField15
                  min="06:00"
                  value={field.value ?? "08:00"}
                  onChange={(next) => {
                    const previous = field.value ?? "08:00";
                    field.onChange(next);
                    const currentReturn = form.getValues("returnTime");
                    const shifted = shiftReturnByDepartureDelta(previous, next, currentReturn);
                    if (shifted !== currentReturn) form.setValue("returnTime", shifted, { shouldDirty: true, shouldValidate: true });
                  }}
                  aria-label={t("field.depart")}
                />
              )}
            />
            <FieldError message={departTimeError} />
          </FormItem>
        ) : null}
        {tripShape !== "one_way_to" ? (
          <Controller
            control={control}
            name="returnTime"
            render={({ field }) =>
              variant === "carNow" ? (
                <></>
              ) : (
                <FormItem className="flex-1" data-field="returnTime">
                  <Label>{tripShape === "one_way_from" ? t("request.departArrival") : t("field.return")}</Label>
                  <TimeField15 min="06:00" max="23:59" value={field.value ?? "12:00"} onChange={field.onChange} aria-label={t("field.return")} />
                  <FieldError message={returnTimeError} />
                </FormItem>
              )
            }
          />
        ) : null}
      </div>

      {variant !== "carNow" && isQuickContext && tripShape === "one_way_from" ? <p className="text-xs text-muted-foreground">{t("quickRequest.arrivalHomeHelp")}</p> : null}
      {variant !== "carNow" && isQuickContext && oneWay ? <p className="text-xs text-muted-foreground">{tv("quickRequest.vehicleWindow", { start: formatTime(new Date(startMs)), end: formatTime(new Date(endMs)) })}</p> : null}

      {isQuickContext && !carIsFree ? (
        <div className="space-y-1.5 rounded-md border-s-4 border-amber-500 bg-amber-50 p-3 text-sm text-amber-900">
          <p>{isAway ? t("quickRequest.awayWarning") : t("quickRequest.overlapWarning")}</p>
          {otherFreeCar ? (
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => form.setValue("preferredCarId", otherFreeCar.id, { shouldDirty: true })}
            >
              {tv("quickRequest.overlapOfferOtherCar", { car: otherFreeCar.name })}
            </Button>
          ) : (
            <p className="text-xs">{t("quickRequest.noCarFree")}</p>
          )}
        </div>
      ) : null}

      {tripShape === "round_trip" && variant !== "carNow" ? (
        <FieldAnchor name="needsCarAtDestination">
          <Controller
            control={control}
            name="needsCarAtDestination"
            render={({ field }) => <CarAtDestinationToggle checked={field.value} onChange={field.onChange} />}
          />
        </FieldAnchor>
      ) : null}
    </>
  );
}

export interface FlexibilityFieldsProps {
  form: UseFormReturn<RequestFormValues>;
  variant: "weekly" | "quick" | "carNow";
  tripShape: RequestFormValues["tripShape"];
  isMultiDay: boolean;
  flexDepartEarly: RequestFormValues["flexDepartEarly"];
  flexDepartLate: RequestFormValues["flexDepartLate"];
  flexReturnEarly: RequestFormValues["flexReturnEarly"];
  flexReturnLate: RequestFormValues["flexReturnLate"];
}

export function FlexibilityFields({ form, variant, tripShape, isMultiDay, flexDepartEarly, flexDepartLate, flexReturnEarly, flexReturnLate }: FlexibilityFieldsProps) {
  if (variant !== "weekly" || isMultiDay) return null;
  return (
    <>
      {tripShape !== "one_way_from" ? (
        <FormItem data-field="flexDepartEarly">
          <Label>{t("field.flexDepart")}</Label>
          <FlexibilityRange
            early={flexDepartEarly}
            late={flexDepartLate}
            onChange={(early, late) => {
              form.setValue("flexDepartEarly", early, { shouldDirty: true });
              form.setValue("flexDepartLate", late, { shouldDirty: true });
            }}
          />
        </FormItem>
      ) : null}
      {tripShape !== "one_way_to" ? (
        <FormItem data-field="flexReturnEarly">
          <Label>{t("field.flexReturn")}</Label>
          <FlexibilityRange
            early={flexReturnEarly}
            late={flexReturnLate}
            onChange={(early, late) => {
              form.setValue("flexReturnEarly", early, { shouldDirty: true });
              form.setValue("flexReturnLate", late, { shouldDirty: true });
            }}
          />
          <p className="text-xs text-muted-foreground">{t("request.flexibilityHelper")}</p>
        </FormItem>
      ) : null}
    </>
  );
}
