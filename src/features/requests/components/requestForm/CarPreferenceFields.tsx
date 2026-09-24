// Extracted from `RequestForm.tsx` (docs/TODO.md "Code review 2026-09-24" R9):
// the car-preference field group — the carNow duration-hours select, the
// ordinary preferred-car select, and the quick-variant free-window car
// picker. Pure move — behaviour and markup unchanged.
import { Controller, type Control } from "react-hook-form";

import { FormItem } from "@/components/ui/form";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { he, t, tv } from "@/i18n/he";

import { CAR_NOW_DEFAULT_HOURS, CAR_NOW_HOURS_OPTIONS } from "../../carNow";
import type { RequestFormValues } from "../../schema";

export interface CarPreferenceFieldsProps {
  control: Control<RequestFormValues>;
  variant: "weekly" | "quick" | "carNow";
  preferredCars: { id: string; name: string }[];
  initialPreferredCarName: string | null | undefined;
  /** Structurally the same shape `QuickRequestContext` exposes — kept local to avoid importing
   * `RequestForm.tsx`'s own type back into this file. */
  quickContext?: { cars: readonly { id: string; name: string }[]; showCarPicker?: boolean };
}

export function CarPreferenceFields({ control, variant, preferredCars, initialPreferredCarName, quickContext }: CarPreferenceFieldsProps) {
  return (
    <>
      {variant === "carNow" ? (
        <FormItem data-field="durationHours">
          <Label htmlFor="request-duration-hours">{t("quickRequest.durationHours")}</Label>
          <Controller
            control={control}
            name="durationHours"
            render={({ field }) => (
              <Select value={String(field.value ?? CAR_NOW_DEFAULT_HOURS)} onValueChange={(value) => field.onChange(Number(value))}>
                <SelectTrigger id="request-duration-hours"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {CAR_NOW_HOURS_OPTIONS.map((hours) => (
                    <SelectItem key={hours} value={String(hours)}>
                      {hours === 1 ? he.quickRequest.hoursOptionOne : tv("quickRequest.hoursOption", { n: String(hours) })}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
          />
        </FormItem>
      ) : null}

      {!quickContext ? (
        <FormItem data-field="preferredCarId">
          <Label htmlFor="request-preferred-car">{t("request.preferredCar")}</Label>
          <Controller control={control} name="preferredCarId" render={({ field }) => (
            <Select value={field.value || "none"} onValueChange={(value) => field.onChange(value === "none" ? "" : value)}>
              <SelectTrigger id="request-preferred-car"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="none">{t("request.noPreferredCar")}</SelectItem>
                {field.value && !preferredCars.some((car) => car.id === field.value) ? (
                  <SelectItem value={field.value} disabled>{initialPreferredCarName ?? t("request.preferredCarUnavailable")}</SelectItem>
                ) : null}
                {preferredCars.map((car) => <SelectItem key={car.id} value={car.id}>{car.name}</SelectItem>)}
              </SelectContent>
            </Select>
          )} />
          <p className="text-xs text-muted-foreground">{t("request.preferredCarHelper")}</p>
        </FormItem>
      ) : quickContext.showCarPicker ? (
        <FormItem data-field="preferredCarId">
          <Label htmlFor="request-preferred-car">{t("quickRequest.carPickerLabel")}</Label>
          <Controller control={control} name="preferredCarId" render={({ field }) => (
            <Select value={field.value || ""} onValueChange={field.onChange}>
              <SelectTrigger id="request-preferred-car"><SelectValue /></SelectTrigger>
              <SelectContent>
                {quickContext.cars.map((car) => <SelectItem key={car.id} value={car.id}>{car.name}</SelectItem>)}
              </SelectContent>
            </Select>
          )} />
        </FormItem>
      ) : null}
    </>
  );
}
