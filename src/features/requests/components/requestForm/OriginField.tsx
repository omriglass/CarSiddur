// REQ §13.93: the origin line above the destination field — "מ<place> אל", tap to change via
// the same `DestinationCombobox` the destination field uses, in "origin" mode (list + free
// text). `carNow` pins the origin to the department home and never renders the tap target.
import { useState } from "react";
import { Controller, type Control } from "react-hook-form";

import { DestinationCombobox, type DestinationPreset } from "@/components/DestinationCombobox";
import { he, t, tv } from "@/i18n/he";

import type { RequestFormValues } from "../../schema";

export interface OriginFieldProps {
  control: Control<RequestFormValues>;
  destinations: readonly DestinationPreset[];
  /** `false` for the `carNow` variant (REQ §13.93: origin fixed to home, not editable). */
  editable: boolean;
}

function placeName(value: RequestFormValues["origin"], destinations: readonly DestinationPreset[]): string {
  if (!value) return "";
  if ("presetId" in value) return destinations.find((d) => d.id === value.presetId)?.name ?? value.name;
  return value.freeText;
}

export function OriginField({ control, destinations, editable }: OriginFieldProps) {
  const [editing, setEditing] = useState(false);

  return (
    <Controller
      control={control}
      name="origin"
      render={({ field }) => {
        const place = placeName(field.value, destinations);
        if (!editable) {
          return (
            <p className="text-sm text-muted-foreground" data-field="origin">
              {tv("request.fromOrigin", { place })}
            </p>
          );
        }
        if (editing) {
          return (
            <div data-field="origin">
              <DestinationCombobox
                destinations={destinations}
                value={field.value}
                onChange={(next) => {
                  field.onChange(next);
                  setEditing(false);
                }}
                placeholder={t("field.origin")}
                autoFocus
              />
            </div>
          );
        }
        return (
          <button
            type="button"
            data-field="origin"
            className="text-start text-sm text-muted-foreground underline-offset-2 hover:underline"
            aria-label={he.field.origin}
            onClick={() => setEditing(true)}
          >
            {tv("request.fromOrigin", { place })}
          </button>
        );
      }}
    />
  );
}
