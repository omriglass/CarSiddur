// UX_FLOWS §3.4a "Stage 2": the modifiers that are not part of the sentence — a one-line recap
// (tap = back to stage 1, plus a back arrow), ride type (colour dots), the car field and the
// weekly-repeat switch (the public description and the Sadran note moved to stage 1, owner
// 2026-10-07). State, not a route.
import { ArrowLeft } from "lucide-react";
import type { ReactNode } from "react";
import { Controller, type FieldErrors, type UseFormReturn } from "react-hook-form";

import { RideTypeChips } from "@/components/RideTypeChips";
import { FormItem } from "@/components/ui/form";
import { Label } from "@/components/ui/label";
import { he } from "@/i18n/he";

import type { RequestFormValues } from "../../../schema";
import { FieldError } from "../FieldError";
import { RepeatWeeklyField } from "../RepeatWeeklyField";
import { CarChoiceField } from "./CarChoiceField";

interface StageTwoProps {
  form: UseFormReturn<RequestFormValues>;
  errors: FieldErrors<RequestFormValues>;
  rideTypes: { id: string; name_he: string; code?: string | null }[];
  preferredCars: { id: string; name: string }[];
  initialPreferredCarName: string | null | undefined;
  /** Weekly variant, single-day request only. */
  showRepeatWeekly: boolean;
  /** The sentence squeezed into one line. */
  recap: ReactNode;
  /** Seat-fit / overlap warnings (R9U4), shown under the recap in the page, not in the footer. */
  notices?: ReactNode;
  onBack: () => void;
}

export function StageTwo({ form, errors, rideTypes, preferredCars, initialPreferredCarName, showRepeatWeekly, recap, notices, onBack }: StageTwoProps) {
  return (
    <div className="space-y-4" data-testid="stage-two">
      <div className="flex items-center rounded-lg border bg-muted/40">
        <button
          type="button"
          className="flex size-10 shrink-0 items-center justify-center rounded-s-lg text-muted-foreground hover:text-foreground"
          aria-label={he.requestSentence.stageBack}
          onClick={onBack}
          data-testid="stage-back"
        >
          <ArrowLeft className="size-4 rtl:rotate-180" aria-hidden="true" />
        </button>
        <button
          type="button"
          className="min-w-0 flex-1 truncate py-2 pe-3 text-start text-sm"
          aria-label={he.requestSentence.recapEdit}
          onClick={onBack}
          data-testid="stage-recap"
        >
          {recap}
        </button>
      </div>

      {notices}

      <FormItem className="space-y-1.5" data-field="rideTypeId">
        <Label className="text-sm">{he.requestSentence.rideType}</Label>
        <Controller
          control={form.control}
          name="rideTypeId"
          render={({ field }) => (
            <RideTypeChips
              dots
              types={rideTypes.map((type) => ({ id: type.id, nameHe: type.name_he, code: type.code }))}
              value={field.value}
              onChange={field.onChange}
            />
          )}
        />
        <FieldError message={errors.rideTypeId?.message} />
      </FormItem>

      <CarChoiceField form={form} control={form.control} preferredCars={preferredCars} initialPreferredCarName={initialPreferredCarName} error={errors.preferredCarId?.message} />

      {showRepeatWeekly ? <RepeatWeeklyField control={form.control} /> : null}
    </div>
  );
}
