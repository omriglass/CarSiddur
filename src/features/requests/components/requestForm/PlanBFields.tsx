// REQ §13.112 (a)/(b) + (e), UX_FLOWS §3.4 "+ תוכנית ב׳": the classic form's plan-B section — collapsed behind a link
// until used; then none / הקפצה / אסתדר, the drop place, "be there by", an optional pickup (place + time). Edits
// the same form fields as the sentence form's "אם אין רכב" line (`sentence/PlanBLine.tsx`) through `planBActions`.
import { useWatch, type FieldErrors, type UseFormReturn } from "react-hook-form";

import { DestinationCombobox, type DestinationValue } from "@/components/DestinationCombobox";
import { TimeField15 } from "@/components/TimeField15";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { he } from "@/i18n/he";

import { dropPointsFirst, earliestPickup, hasAltPlace, planBOffered } from "../../planB";
import type { RequestFormValues } from "../../schema";
import { FieldError } from "./FieldError";
import { planBActions } from "./planBActions";

interface PlanBFieldsProps {
  form: UseFormReturn<RequestFormValues>;
  errors: FieldErrors<RequestFormValues>;
  destinations: readonly { id: string; name: string; aliases: string[]; zone?: string; is_drop_point?: boolean }[];
}

export function PlanBFields({ form, errors, destinations }: PlanBFieldsProps) {
  const values = useWatch({ control: form.control });
  const scope = { tripType: values.tripType ?? "round_trip", day: values.day ?? "", returnDay: values.returnDay };
  if (!planBOffered(scope)) return null;

  const actions = planBActions(form);
  const fallback = values.fallback ?? "none";
  const alternative = fallback === "alternative";
  const pickup = !!values.altPickup;
  const place = (values.altPlace as DestinationValue | undefined) ?? null;
  const pickupPlace = (values.altPickupPlace as DestinationValue | undefined) ?? null;
  const arriveBy = values.altArriveBy ?? "08:00";
  const places = dropPointsFirst(destinations);

  if (fallback === "none") {
    return (
      <div data-testid="plan-b" data-field="fallback">
        <button
          type="button"
          className="relative min-h-11 text-sm text-primary before:absolute before:-inset-2 before:content-[''] hover:underline"
          onClick={() => actions.choose("alternative")}
          data-testid="plan-b-link"
        >
          {he.planB.classic.link}
        </button>
      </div>
    );
  }

  return (
    <div className="space-y-3 rounded-md border p-3" data-testid="plan-b" data-field="fallback">
      <div className="space-y-1.5">
        <Label className="text-sm font-medium">{he.planB.classic.title}</Label>
        <ToggleGroup
          type="single"
          value={fallback}
          onValueChange={(next) => {
            if (next) actions.choose(next as "none" | "alternative" | "manage");
          }}
          className="flex-wrap justify-start gap-1.5"
          aria-label={he.planB.classic.kind}
        >
          {([["alternative", he.planB.options.alternative], ["manage", he.planB.options.manage], ["none", he.planB.options.none]] as const).map(([value, label]) => (
            <ToggleGroupItem key={value} value={value} data-testid={`plan-b-option-${value}`} className="h-11 px-3 text-sm">
              {label}
            </ToggleGroupItem>
          ))}
        </ToggleGroup>
      </div>

      {alternative ? (
        <>
          <div className="space-y-1" data-field="altPlace">
            <Label className="text-sm">{he.planB.classic.place}</Label>
            <DestinationCombobox
              destinations={places}
              value={hasAltPlace(place ?? undefined) ? place : null}
              onChange={actions.pickPlace}
              placeholder={he.planB.placeEmpty}
            />
            <FieldError message={errors.altPlace?.message} />
          </div>

          <div className="space-y-1" data-field="altArriveBy">
            <Label className="text-sm">{he.planB.classic.arrive}</Label>
            <TimeField15 value={arriveBy} onChange={(next) => actions.setArriveBy(next)} aria-label={he.planB.classic.arrive} />
            <FieldError message={errors.altArriveBy?.message} />
          </div>

          <div className="flex items-center justify-between gap-2">
            <Label htmlFor="plan-b-pickup-switch">{he.planB.classic.pickupSwitch}</Label>
            <Switch id="plan-b-pickup-switch" checked={pickup} onCheckedChange={actions.setPickup} data-testid="plan-b-pickup-switch" />
          </div>

          {pickup ? (
            <>
              <div className="space-y-1" data-field="altPickupPlace">
                <Label className="text-sm">{he.planB.classic.pickupPlace}</Label>
                <div className="flex items-center gap-2">
                  <div className="min-w-0 flex-1">
                    <DestinationCombobox
                      destinations={places}
                      value={hasAltPlace(pickupPlace ?? undefined) ? pickupPlace : null}
                      onChange={actions.pickPickupPlace}
                      placeholder={he.planB.classic.pickupPlaceSame}
                    />
                  </div>
                  {hasAltPlace(pickupPlace ?? undefined) ? (
                    <button type="button" className="min-h-11 shrink-0 px-2 text-sm text-primary hover:underline" onClick={() => actions.pickPickupPlace(undefined)} data-testid="plan-b-pickup-same-place">
                      {he.planB.classic.pickupPlaceSame}
                    </button>
                  ) : null}
                </div>
                <FieldError message={errors.altPickupPlace?.message} />
              </div>
              <div className="space-y-1" data-field="altPickupAt">
                <Label className="text-sm">{he.planB.classic.pickupAt}</Label>
                <TimeField15 min={earliestPickup(arriveBy)} value={values.altPickupAt ?? earliestPickup(arriveBy)} onChange={(next) => actions.set.altPickupAt(next)} aria-label={he.planB.classic.pickupAt} />
                <FieldError message={errors.altPickupAt?.message} />
              </div>
            </>
          ) : null}
        </>
      ) : null}
    </div>
  );
}
