import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { he } from "@/i18n/he";
import { TRIP_SHAPES } from "@/lib/enums";

import type { TripShape } from "@/lib/enums";

/** = SQL `trip_shape` (`src/lib/enums.ts`). */
export { TRIP_SHAPES };
export type TripShapeValue = TripShape;

const LABEL_BY_VALUE: Record<TripShapeValue, string> = {
  round_trip: he.request.tripShapeRoundTrip,
  one_way_to: he.request.tripShapeOneWayTo,
  one_way_from: he.request.tripShapeOneWayFrom,
};

interface TripShapeControlProps {
  value: TripShapeValue;
  onChange: (value: TripShapeValue) => void;
}

/** `הלוך ושוב / הלוך בלבד / חזור בלבד` segmented control (UX_FLOWS.md §3.4 `TripShapeControl`). */
export function TripShapeControl({ value, onChange }: TripShapeControlProps) {
  return (
    <ToggleGroup
      type="single"
      value={value}
      onValueChange={(next) => {
        if (!next) return;
        onChange(next as TripShapeValue);
      }}
      className="flex-wrap justify-start"
      aria-label={he.field.roundTrip}
    >
      {TRIP_SHAPES.map((shape) => (
        <ToggleGroupItem key={shape} value={shape} className="h-11 px-3 text-sm">
          {LABEL_BY_VALUE[shape]}
        </ToggleGroupItem>
      ))}
    </ToggleGroup>
  );
}
