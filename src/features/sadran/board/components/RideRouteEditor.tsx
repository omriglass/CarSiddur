// REQ §13.94 (G8): the ride sheet's "מסלול" section - start place, end place and stops per leg
// (same `DestinationCombobox` and stop chips as the request form). Saving hands the values to the
// board: a ride serving a member's request becomes a `shift` proposal (draft or compose), a
// reservation is saved with `edit_ride`.
import { X } from "lucide-react";
import { useState } from "react";

import { DestinationCombobox, type DestinationPreset, type DestinationValue } from "@/components/DestinationCombobox";
import { Button } from "@/components/ui/button";
import { he } from "@/i18n/he";

import { routeEditChanged, type RouteEditValues } from "../rideRouteEdit";

const MAX_STOPS = 10;

function valueName(value: DestinationValue | null, destinations: readonly DestinationPreset[]): string {
  if (!value) return "";
  if ("presetId" in value) return destinations.find((d) => d.id === value.presetId)?.name ?? value.name;
  return value.freeText;
}

interface StopChipsProps {
  testId: string;
  values: DestinationValue[];
  onChange: (next: DestinationValue[]) => void;
  destinations: readonly DestinationPreset[];
  addLabel: string;
}

function StopChips({ testId, values, onChange, destinations, addLabel }: StopChipsProps) {
  const [adding, setAdding] = useState(false);
  return (
    <div className="flex flex-wrap items-center gap-1.5" data-testid={testId}>
      {values.map((value, index) => (
        <span key={`${index}:${valueName(value, destinations)}`} className="inline-flex max-w-full items-center gap-1 rounded-full border bg-muted px-2 py-1 text-xs">
          <span className="truncate">{valueName(value, destinations)}</span>
          <button type="button" aria-label={he.rideRouteEdit.removeStop} className="shrink-0 text-muted-foreground hover:text-foreground" onClick={() => onChange(values.filter((_, i) => i !== index))}>
            <X className="size-3" aria-hidden="true" />
          </button>
        </span>
      ))}
      {adding ? (
        <div className="w-full max-w-xs">
          <DestinationCombobox
            destinations={destinations}
            value={null}
            onChange={(next) => { if (values.length < MAX_STOPS) onChange([...values, next]); setAdding(false); }}
            placeholder={he.request.stopPlaceholder}
            autoFocus
          />
        </div>
      ) : values.length < MAX_STOPS ? (
        <button type="button" className="min-h-8 text-xs text-muted-foreground underline-offset-2 hover:underline" onClick={() => setAdding(true)}>{addLabel}</button>
      ) : null}
    </div>
  );
}

export interface RideRouteEditorProps {
  initial: RouteEditValues;
  destinations: readonly DestinationPreset[];
  /** `false` for a reservation: two list places, no stops (`edit_ride` has none). */
  stopsEditable: boolean;
  /** The request has a return leg - return stops are offered only then. */
  hasReturn: boolean;
  saving?: boolean;
  onSave: (values: RouteEditValues) => void;
}

export function RideRouteEditor({ initial, destinations, stopsEditable, hasReturn, saving, onSave }: RideRouteEditorProps) {
  const [values, setValues] = useState<RouteEditValues>(initial);
  const changed = routeEditChanged(initial, values);
  return (
    <div className="space-y-2 rounded-md border p-3" data-testid="ride-route-editor">
      <span className="font-medium">{he.rideRouteEdit.title}</span>
      <div className="space-y-1">
        <label className="block text-xs text-muted-foreground">{he.rideRouteEdit.start}</label>
        <div data-testid="ride-route-origin">
          <DestinationCombobox destinations={destinations} value={values.origin} onChange={(origin) => setValues((v) => ({ ...v, origin }))} placeholder={he.rideRouteEdit.placePlaceholder} />
        </div>
      </div>
      <div className="space-y-1">
        <label className="block text-xs text-muted-foreground">{he.rideRouteEdit.end}</label>
        <div data-testid="ride-route-destination">
          <DestinationCombobox destinations={destinations} value={values.destination} onChange={(destination) => setValues((v) => ({ ...v, destination }))} placeholder={he.rideRouteEdit.placePlaceholder} />
        </div>
      </div>
      {stopsEditable ? (
        <>
          <div className="space-y-1">
            <span className="block text-xs text-muted-foreground">{he.rideRouteEdit.stopsOut}</span>
            <StopChips testId="ride-route-stops-out" values={values.outStops} onChange={(outStops) => setValues((v) => ({ ...v, outStops }))} destinations={destinations} addLabel={he.rideRouteEdit.addStopOut} />
          </div>
          {hasReturn ? (
            <div className="space-y-1">
              <span className="block text-xs text-muted-foreground">{he.rideRouteEdit.stopsReturn}</span>
              <StopChips testId="ride-route-stops-return" values={values.returnStops} onChange={(returnStops) => setValues((v) => ({ ...v, returnStops }))} destinations={destinations} addLabel={he.rideRouteEdit.addStopReturn} />
            </div>
          ) : null}
        </>
      ) : <p className="text-xs text-muted-foreground">{he.rideRouteEdit.noStopsOnReservation}</p>}
      <Button type="button" variant="secondary" className="min-h-11 w-full" disabled={!changed || saving} onClick={() => onSave(values)} data-testid="ride-route-save">
        {he.rideRouteEdit.save}
      </Button>
    </div>
  );
}
