// REQUIREMENTS §13.93 "Multi-stop rides": compact, collapsed-by-default stop chips — nothing
// extra is visible until the member taps "+ עצירה"/"+ עצירה בחזור". Opens the same
// `DestinationCombobox` the origin/destination fields use (list + free text) inline, right
// where the link was, and closes itself the moment a place is picked (owner, 2026-10-04:
// "the form is a bit unwieldy as it is" — stops must stay out of the way until used).
import { useState } from "react";
import { Controller, useFieldArray, type Control } from "react-hook-form";
import { X } from "lucide-react";

import { DestinationCombobox, type DestinationPreset, type DestinationValue } from "@/components/DestinationCombobox";
import { t } from "@/i18n/he";

import type { RequestFormValues } from "../../schema";

const MAX_STOPS = 10;

export interface StopsFieldProps {
  control: Control<RequestFormValues>;
  name: "outStops" | "returnStops";
  destinations: readonly DestinationPreset[];
  addLabel: string;
  removeAriaLabel: string;
}

function stopName(value: DestinationValue, destinations: readonly DestinationPreset[]): string {
  if ("presetId" in value) return destinations.find((d) => d.id === value.presetId)?.name ?? value.name;
  return value.freeText;
}

/** Out- or return-stop chips (REQUIREMENTS §13.93 "Multi-stop rides") — one `StopsField` per leg. */
export function StopsField({ control, name, destinations, addLabel, removeAriaLabel }: StopsFieldProps) {
  const { fields, append, remove } = useFieldArray({ control, name });
  const [adding, setAdding] = useState(false);

  return (
    <div className="flex flex-wrap items-center gap-1.5" data-field={name}>
      {fields.map((field, index) => (
        <Controller
          key={field.id}
          control={control}
          name={`${name}.${index}` as const}
          render={({ field: itemField }) => (
            <span className="inline-flex max-w-full items-center gap-1 rounded-full border bg-muted px-2 py-1 text-xs">
              <span className="truncate">{stopName(itemField.value, destinations)}</span>
              <button
                type="button"
                aria-label={removeAriaLabel}
                className="shrink-0 text-muted-foreground hover:text-foreground"
                onClick={() => remove(index)}
              >
                <X className="size-3" aria-hidden="true" />
              </button>
            </span>
          )}
        />
      ))}
      {adding ? (
        <div className="w-full max-w-xs">
          <DestinationCombobox
            destinations={destinations}
            value={null}
            onChange={(next) => {
              if (fields.length < MAX_STOPS) append(next);
              setAdding(false);
            }}
            placeholder={t("request.stopPlaceholder")}
            autoFocus
          />
        </div>
      ) : fields.length < MAX_STOPS ? (
        <button
          type="button"
          className="text-xs text-muted-foreground underline-offset-2 hover:underline"
          onClick={() => setAdding(true)}
        >
          {addLabel}
        </button>
      ) : null}
    </div>
  );
}
