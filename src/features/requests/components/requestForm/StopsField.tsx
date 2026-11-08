// REQUIREMENTS §13.93 "Multi-stop rides", TODO ST1: the classic form's stops control — one
// "+ עוד מקום בדרך" link (asks which leg only when the trip has a return) plus the live route
// line. Opens the same `DestinationCombobox` the origin/destination fields use (list + free
// text) inline, and closes itself the moment a place is picked. Shared behaviour: `StopsRoute`.
import { useWatch, type UseFormReturn } from "react-hook-form";

import { DestinationCombobox, type DestinationPreset, type DestinationValue } from "@/components/DestinationCombobox";
import { t } from "@/i18n/he";

import type { RequestFormValues } from "../../schema";
import type { StopLeg } from "./routeLine";
import { placeName } from "./routeLine";
import { MAX_STOPS, StopsRoute } from "./StopsRoute";

export interface StopsFieldProps {
  form: UseFormReturn<RequestFormValues>;
  destinations: readonly DestinationPreset[];
  /** The trip has a return leg (round trip, or הקפצה with a pickup). */
  hasReturn: boolean;
  /** First validation message of any stop (R3B21: stop equals origin/destination). */
  error?: string;
}

const FIELD = { out: "outStops", return: "returnStops" } as const;

export function StopsField({ form, destinations, hasReturn, error }: StopsFieldProps) {
  const [origin, destination, outStops, returnStops] = useWatch({
    control: form.control,
    name: ["origin", "destination", "outStops", "returnStops"],
  }) as [DestinationValue | null, DestinationValue | null, DestinationValue[] | undefined, DestinationValue[] | undefined];
  const out = outStops ?? [];
  const back = returnStops ?? [];

  function add(leg: StopLeg, value: DestinationValue) {
    const current = (form.getValues(FIELD[leg]) ?? []) as DestinationValue[];
    if (current.length < MAX_STOPS) form.setValue(FIELD[leg], [...current, value], { shouldDirty: true, shouldValidate: true });
  }

  function remove(leg: StopLeg, index: number) {
    const current = (form.getValues(FIELD[leg]) ?? []) as DestinationValue[];
    form.setValue(FIELD[leg], current.filter((_, i) => i !== index), { shouldDirty: true, shouldValidate: true });
  }

  return (
    <StopsRoute
      origin={placeName(origin, destinations)}
      destination={placeName(destination, destinations)}
      outStops={out.map((stop) => placeName(stop, destinations))}
      returnStops={back.map((stop) => placeName(stop, destinations))}
      hasReturn={hasReturn}
      onRemove={remove}
      error={error}
      renderPicker={(done, leg) => (
        <div className="max-w-xs">
          <DestinationCombobox
            destinations={destinations}
            value={null}
            onChange={(next) => { add(leg, next); done(); }}
            placeholder={t("request.stopPlaceholder")}
            autoFocus
          />
        </div>
      )}
    />
  );
}
