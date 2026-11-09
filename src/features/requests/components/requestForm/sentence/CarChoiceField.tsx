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
  preferredCars: { id: string; name: string; isPrivate?: boolean }[];
  initialPreferredCarName: string | null | undefined;
  error?: string;
}

export function CarChoiceField({ form, control, preferredCars, initialPreferredCarName, error }: CarChoiceFieldProps) {
  const values = useWatch({ control });
  const current = { luggage: values.luggage ?? false, preferredCarId: values.preferredCarId ?? "", preferSpecificCar: values.preferSpecificCar };
  const choice = carChoiceOf(current);
  // REQ §13.206 (b): my private car meets every car need - nothing refuses it, the form only notes it.
  const privateChosen = preferredCars.some((car) => car.isPrivate && car.id === current.preferredCarId);
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
        {/* REQ §13.200: towing is its own need beside the car choice — a chip toggled on its own (a request may need both luggage and towing) */}
        <PillChip
          pressed={values.towHitch ?? false}
          data-testid="tow-hitch-chip"
          onClick={() => form.setValue("towHitch", !(values.towHitch ?? false), { shouldDirty: true })}
        >
          {t("request.towLabel")}
        </PillChip>
      </div>
      {choice === "luggage" ? <p className="text-xs text-muted-foreground">{t("request.luggageHint")}</p> : null}
      {values.towHitch ? <p className="text-xs text-muted-foreground">{t("request.towHint")}</p> : null}
      {choice === "specific" ? (
        <div className="space-y-1">
          {/* Production 2026-11-09: luggage kept from an earlier choice was invisible under "רכב מסוים" - it can be removed here. */}
          {hasCarAndLuggage(current) ? (
            <p className="flex items-center gap-1 text-xs font-medium">
              {he.requestSentence.carAlsoLuggage}
              <button
                type="button"
                className="inline-flex min-h-8 min-w-8 items-center justify-center rounded-full text-muted-foreground hover:bg-accent"
                aria-label={he.requestSentence.carAlsoLuggageRemove}
                data-testid="car-also-luggage-remove"
                onClick={() => form.setValue("luggage", false, { shouldDirty: true })}
              >
                ✕
              </button>
            </p>
          ) : null}
          {privateChosen && (values.luggage || values.towHitch) ? (
            <p className="text-xs text-muted-foreground" data-testid="private-car-needs-note">{he.requestSentence.privateCarNeedsNote}</p>
          ) : null}
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
