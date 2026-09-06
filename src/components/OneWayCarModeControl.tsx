import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Label } from "@/components/ui/label";
import { he } from "@/i18n/he";

import type { TripShapeValue } from "@/components/TripShapeControl";

/** = SQL `leg_car_mode`, restricted to the two values a member may pick (relay/passenger). */
export type OneWayCarModeValue = "relay" | "passenger";

interface OneWayCarModeControlProps {
  value: OneWayCarModeValue | null;
  /** Picks the "car left there" label wording (out-leg vs. return-leg, UX_FLOWS §3.4). */
  tripShape: Extract<TripShapeValue, "one_way_to" | "one_way_from">;
  onChange: (value: OneWayCarModeValue) => void;
}

/** "אני נוהג/ת ומשאיר/ה את הרכב שם" (relay) vs. "אני צריך/ה הסעה" (passenger) — one-way shapes only. */
export function OneWayCarModeControl({ value, tripShape, onChange }: OneWayCarModeControlProps) {
  const relayLabel =
    tripShape === "one_way_from" ? he.request.oneWayModeRelayFrom : he.request.oneWayModeRelayTo;

  return (
    <div className="space-y-2">
      <RadioGroup
        value={value ?? undefined}
        onValueChange={(next) => onChange(next as OneWayCarModeValue)}
        className="gap-2"
      >
        <Label className="flex min-h-11 items-center gap-2 rounded-md border p-2 text-sm">
          <RadioGroupItem value="relay" />
          {relayLabel}
        </Label>
        <Label className="flex min-h-11 items-center gap-2 rounded-md border p-2 text-sm">
          <RadioGroupItem value="passenger" />
          {he.request.oneWayModePassenger}
        </Label>
      </RadioGroup>
      {value === "relay" ? (
        <p className="text-xs text-muted-foreground">{he.request.oneWayModeHelper}</p>
      ) : null}
    </div>
  );
}
