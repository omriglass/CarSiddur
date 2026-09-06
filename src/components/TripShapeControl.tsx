import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { he } from "@/i18n/he";

/** = SQL `trip_shape` (Database["public"]["Enums"]["trip_shape"]). */
export const TRIP_SHAPES = ["round_trip", "one_way_to", "one_way_from"] as const;
export type TripShapeValue = (typeof TRIP_SHAPES)[number];

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
