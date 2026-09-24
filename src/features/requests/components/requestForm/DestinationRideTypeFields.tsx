// Extracted from `RequestForm.tsx` (docs/TODO.md "Code review 2026-09-24" R9):
// the destination + ride-type field group. Pure move — behaviour, markup and
// every `data-field=` attribute unchanged.
import { Controller, type Control } from "react-hook-form";

import { FormItem } from "@/components/ui/form";
import { Label } from "@/components/ui/label";
import { DestinationCombobox, type DestinationValue } from "@/components/DestinationCombobox";
import { RideTypeChips } from "@/components/RideTypeChips";
import { t } from "@/i18n/he";

import { destinationLabelKey } from "../../destinationLabel";
import type { RequestFormValues } from "../../schema";
import { FieldError } from "./FieldError";

export interface DestinationRideTypeFieldsProps {
  control: Control<RequestFormValues>;
  destinations: { id: string; name: string; aliases: string[]; zone: string }[];
  rideTypes: { id: string; name_he: string }[];
  tripShape: RequestFormValues["tripShape"];
  variant: "weekly" | "quick" | "carNow";
  destinationHasError: boolean;
  rideTypeError: string | undefined;
}

export function DestinationRideTypeFields({ control, destinations, rideTypes, tripShape, variant, destinationHasError, rideTypeError }: DestinationRideTypeFieldsProps) {
  return (
    <>
      <FormItem data-field="destination">
        <Label>{t(destinationLabelKey(tripShape))}</Label>
        <Controller
          control={control}
          name="destination"
          render={({ field }) => (
            <DestinationCombobox
              destinations={destinations.map((d) => ({
                id: d.id,
                name: d.name,
                aliases: d.aliases,
                zone: d.zone,
              }))}
              value={field.value as DestinationValue}
              onChange={field.onChange}
              autoFocus={variant === "quick" || variant === "carNow"}
            />
          )}
        />
        <FieldError message={destinationHasError ? t("request.destinationRequired") : undefined} />
      </FormItem>

      <FormItem data-field="rideTypeId">
        <Label>{t("field.rideType")}</Label>
        <Controller
          control={control}
          name="rideTypeId"
          render={({ field }) => (
            <RideTypeChips
              types={rideTypes.map((rt) => ({ id: rt.id, nameHe: rt.name_he }))}
              value={field.value}
              onChange={field.onChange}
            />
          )}
        />
        <FieldError message={rideTypeError} />
      </FormItem>
    </>
  );
}
