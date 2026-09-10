import { Minus, Plus } from "lucide-react";

import { Button } from "@/components/ui/button";
import { t } from "@/i18n/he";

export interface PassengerCounts {
  adults: number;
  childSeats: number;
  boosters: number;
}

export type PassengerField = keyof PassengerCounts;

const BOUNDS: Record<PassengerField, { min: number; max: number }> = {
  adults: { min: 1, max: 8 },
  childSeats: { min: 0, max: 8 },
  boosters: { min: 0, max: 8 },
};

/** Clamps a single field of `PassengerCounts` to its allowed range (adults ≥ 1, UX_FLOWS.md §3.4). */
export function clampPassengerField(field: PassengerField, value: number): number {
  const { min, max } = BOUNDS[field];
  return Math.min(Math.max(value, min), max);
}

interface PassengerStepperProps {
  value: PassengerCounts;
  onChange: (value: PassengerCounts) => void;
  /** react-hook-form field name, for `useScrollToFirstError` to find this control on an invalid submit. */
  dataField?: string;
}

const FIELDS: { field: PassengerField; label: string }[] = [
  { field: "adults", label: t("field.adults") },
  { field: "childSeats", label: t("field.childSeats") },
  { field: "boosters", label: t("field.boosters") },
];

/** Three 44px steppers: adults (min 1, includes the driver), child seats, boosters. */
export function PassengerStepper({ value, onChange, dataField }: PassengerStepperProps) {
  function step(field: PassengerField, delta: number) {
    const next = clampPassengerField(field, value[field] + delta);
    onChange({ ...value, [field]: next });
  }

  return (
    <div className="space-y-3" data-field={dataField}>
      {FIELDS.map(({ field, label }) => (
        <div key={field} className="flex items-center justify-between gap-3">
          <span className="text-sm">{label}</span>
          <div className="flex items-center gap-2">
            <Button
              type="button"
              variant="outline"
              size="icon"
              className="h-11 w-11"
              aria-label={`${label} -1`}
              disabled={value[field] <= BOUNDS[field].min}
              onClick={() => step(field, -1)}
            >
              <Minus className="size-4" />
            </Button>
            <span className="w-6 text-center tabular-nums" dir="ltr">
              {value[field]}
            </span>
            <Button
              type="button"
              variant="outline"
              size="icon"
              className="h-11 w-11"
              aria-label={`${label} +1`}
              disabled={value[field] >= BOUNDS[field].max}
              onClick={() => step(field, 1)}
            >
              <Plus className="size-4" />
            </Button>
          </div>
        </div>
      ))}
    </div>
  );
}
