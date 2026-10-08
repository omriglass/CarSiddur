// REQ §13.112 (e): "במקום [הלוך-חזור לחיפה], הקפצה ל[…] עד [08:00] ואיסוף מ[…] ב־[19:00]" — the plan-B details
// asked as one sentence when the member switches a request without a plan B to הקפצה (`useDropOffSwitch`).
// Places are picked in a second view of the same dialog (the inline search list of the sentence form) instead of a
// popover, which would not fit inside a phone-sized dialog.
import { ChevronsUpDown, MapPin } from "lucide-react";
import { useState } from "react";

import type { DestinationValue } from "@/components/DestinationCombobox";
import { FormDialog } from "@/components/FormDialog";
import { TimeField15 } from "@/components/TimeField15";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { he, tv } from "@/i18n/he";
import type { TripType } from "@/lib/enums";

import { defaultPlanB, dropPointsFirst, earliestPickup, hasAltPlace, pickupAfterArrivalMoved, type PlanBDetails } from "../../planB";
import { isSamePlace, type RequestFormValues } from "../../schema";
import { FieldError } from "./FieldError";
import { PlacePicker, type PlaceOption } from "./sentence/PlacePicker";

const TRIP_LABEL: Record<TripType, string> = {
  round_trip: he.request.tripTypeRoundTrip,
  one_way: he.request.tripTypeOneWay,
  drop_off: he.request.tripTypeDropOff,
};

function placeName(value: DestinationValue | null | undefined): string {
  if (!value) return "";
  return "presetId" in value ? value.name : value.freeText;
}

interface DropOffSwitchDialogProps {
  values: RequestFormValues;
  destinations: readonly { id: string; name: string; aliases: string[]; zone?: string; is_drop_point?: boolean }[];
  onCancel: () => void;
  onConfirm: (plan: PlanBDetails) => void;
}

function PlaceButton({ value, placeholder, onClick, testId }: { value: DestinationValue | null; placeholder: string; onClick: () => void; testId: string }) {
  return (
    <Button type="button" variant="outline" className="h-11 w-full justify-between font-normal" onClick={onClick} data-testid={testId}>
      <span className="flex min-w-0 items-center gap-2">
        <MapPin className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
        <span className="truncate">{placeName(value) || placeholder}</span>
      </span>
      <ChevronsUpDown className="size-4 shrink-0 opacity-50" aria-hidden="true" />
    </Button>
  );
}

export function DropOffSwitchDialog({ values, destinations, onCancel, onConfirm }: DropOffSwitchDialogProps) {
  const defaults = defaultPlanB({ tripType: values.tripType, departTime: values.departTime, returnTime: values.returnTime, arriveByTime: values.arriveByTime, departAnchor: values.departAnchor ?? "leave" });
  const [place, setPlace] = useState<DestinationValue | null>(hasAltPlace(values.altPlace) ? (values.altPlace as DestinationValue) : null);
  const [arriveBy, setArriveBy] = useState(values.altArriveBy ?? defaults.altArriveBy ?? "09:00");
  const [pickup, setPickup] = useState(values.altPickup ?? values.tripType === "round_trip");
  const [pickupAt, setPickupAt] = useState(values.altPickupAt ?? defaults.altPickupAt ?? earliestPickup(arriveBy));
  const [pickupPlace, setPickupPlace] = useState<DestinationValue | null>(hasAltPlace(values.altPickupPlace) ? (values.altPickupPlace as DestinationValue) : null);
  const [picking, setPicking] = useState<"place" | "pickupPlace" | null>(null);
  const [error, setError] = useState<string | null>(null);

  const options: PlaceOption[] = dropPointsFirst(destinations).map((d) => ({ id: d.id, name: d.name, aliases: d.aliases, zone: d.zone, tag: d.is_drop_point ? he.planB.dropPointTag : undefined }));
  const current = placeName(values.destination as DestinationValue);
  const trip = current ? tv("planB.originalRoute", { trip: TRIP_LABEL[values.tripType], destination: current }) : TRIP_LABEL[values.tripType];

  function submit() {
    if (!place || !hasAltPlace(place)) return setError(he.planB.error.placeRequired);
    if (isSamePlace(place, values.origin)) return setError(he.planB.error.sameAsOrigin);
    if (pickup && pickupAt <= arriveBy) return setError(he.planB.error.pickupBeforeArrive);
    onConfirm({
      place,
      arriveBy,
      pickup,
      pickupAt: pickup ? pickupAt : undefined,
      pickupPlace: pickup && pickupPlace && !isSamePlace(pickupPlace, place) ? pickupPlace : undefined,
    });
  }

  return (
    <FormDialog
      open
      onOpenChange={(open) => { if (!open) onCancel(); }}
      title={picking === "place" ? he.planB.sheet.place : picking === "pickupPlace" ? he.planB.sheet.pickupPlace : he.planB.switch.title}
      description={picking ? undefined : tv("planB.switch.instead", { trip })}
      onSubmit={submit}
      submitLabel={he.planB.switch.confirm}
      className="max-w-md"
      footer={picking ? <Button type="button" variant="outline" className="w-full sm:w-auto" onClick={() => setPicking(null)}>{he.common.back}</Button> : undefined}
    >
      {picking ? (
        <div data-testid="drop-off-switch-picker">
          <PlacePicker
            places={options}
            value={picking === "place" ? place : pickupPlace}
            placeholder={he.planB.placeSearch}
            onPick={(next) => {
              if (picking === "place") setPlace(next);
              else setPickupPlace(next);
              setError(null);
              setPicking(null);
            }}
          />
        </div>
      ) : (
      <div className="space-y-3" data-testid="drop-off-switch-dialog">
        <div className="space-y-1" data-field="altPlace">
          <Label className="text-sm">{he.planB.switch.toPlace}</Label>
          <PlaceButton value={place} placeholder={he.planB.placeEmpty} onClick={() => setPicking("place")} testId="drop-off-switch-place" />
        </div>
        <div className="flex items-center gap-3">
          <Label className="text-sm">{he.planB.switch.untilTime}</Label>
          <TimeField15
            value={arriveBy}
            onChange={(next) => {
              const moved = pickupAfterArrivalMoved(arriveBy, next, pickupAt);
              if (pickup && moved.pickupAt) setPickupAt(moved.pickupAt);
              setArriveBy(next);
              setError(null);
            }}
            aria-label={he.planB.switch.untilTime}
          />
        </div>
        <div className="flex items-center justify-between gap-2">
          <Label htmlFor="drop-off-switch-pickup">{he.planB.switch.pickupSwitch}</Label>
          <Switch id="drop-off-switch-pickup" checked={pickup} onCheckedChange={setPickup} />
        </div>
        {pickup ? (
          <>
            <div className="space-y-1">
              <Label className="text-sm">{he.planB.switch.pickupFromPlace}</Label>
              <PlaceButton value={pickupPlace} placeholder={he.planB.classic.pickupPlaceSame} onClick={() => setPicking("pickupPlace")} testId="drop-off-switch-pickup-place" />
              {pickupPlace ? (
                <button type="button" className="min-h-11 text-sm text-primary hover:underline" onClick={() => setPickupPlace(null)}>
                  {he.planB.classic.pickupPlaceSame}
                </button>
              ) : null}
            </div>
            <div className="flex items-center gap-3">
              <Label className="text-sm">{he.planB.switch.atTime}</Label>
              <TimeField15 min={earliestPickup(arriveBy)} value={pickupAt} onChange={(next) => { setPickupAt(next); setError(null); }} aria-label={he.planB.switch.atTime} />
            </div>
          </>
        ) : null}
        <FieldError message={error ?? undefined} />
      </div>
      )}
    </FormDialog>
  );
}
