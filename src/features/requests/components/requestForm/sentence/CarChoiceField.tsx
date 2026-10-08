// UX_FLOWS §3.4a: the car field of stage 2 — one radio over the classic
// `luggage` + `preferredCarId` fields: לא משנה / צריך/ה תא מטען גדול / רכב מסוים (+ the existing
// preferred-car select). A request that has both keeps both values.
import { useWatch, type Control, type UseFormReturn } from "react-hook-form";

import { FormItem } from "@/components/ui/form";
import { Label } from "@/components/ui/label";
import { he, t } from "@/i18n/he";

import type { RequestFormValues } from "../../../schema";
import { CarPreferenceFields } from "../CarPreferenceFields";
import { PillChip } from "./PillChip";
import { applyCarChoice, carChoiceOf, hasCarAndLuggage, type CarChoice } from "./sentenceModel";

interface CarChoiceFieldProps {
  form: UseFormReturn<RequestFormValues>;
  control: Control<RequestFormValues>;
  preferredCars: { id: string; name: string }[];
  initialPreferredCarName: string | null | undefined;
  error?: string;
}

export function CarChoiceField({ form, control, preferredCars, initialPreferredCarName, error }: CarChoiceFieldProps) {
  const values = useWatch({ control });
  const current = { luggage: values.luggage ?? false, preferredCarId: values.preferredCarId ?? "", preferSpecificCar: values.preferSpecificCar };
  const choice = carChoiceOf(current);
  const options: { value: CarChoice; label: string }[] = [
    { value: "any", label: he.requestSentence.carAny },
    { value: "luggage", label: he.requestSentence.carLuggage },
    { value: "specific", label: he.requestSentence.carSpecific },
  ];

  return (
    <FormItem className="space-y-1.5" data-field="luggage">
      <Label className="text-sm">{he.requestSentence.car}</Label>
      <div className="flex flex-wrap gap-1.5" role="group" aria-label={he.requestSentence.car}>
        {options.map((option) => (
          <PillChip
            key={option.value}
            pressed={choice === option.value}
            disabled={option.value === "specific" && preferredCars.length === 0}
            data-testid={`car-choice-${option.value}`}
            onClick={() => {
              const patch = applyCarChoice(option.value, current);
              form.setValue("luggage", patch.luggage, { shouldDirty: true });
              form.setValue("preferSpecificCar", patch.preferSpecificCar, { shouldDirty: true });
              form.setValue("preferredCarId", patch.preferredCarId, { shouldDirty: true });
              form.clearErrors("preferredCarId");
            }}
          >
            {option.label}
          </PillChip>
        ))}
      </div>
      {choice === "luggage" ? <p className="text-xs text-muted-foreground">{t("request.luggageHint")}</p> : null}
      {choice === "specific" ? (
        <div className="space-y-1">
          {hasCarAndLuggage(current) ? <p className="text-xs font-medium">{he.requestSentence.carAlsoLuggage}</p> : null}
          <CarPreferenceFields
            control={control}
            variant="weekly"
            preferredCars={preferredCars}
            initialPreferredCarName={initialPreferredCarName}
            askForCar
            error={error}
          />
        </div>
      ) : null}
    </FormItem>
  );
}
