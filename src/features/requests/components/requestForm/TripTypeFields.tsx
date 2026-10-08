// REQ §13.93: the three-option trip-type control (הלוך-חזור / הלוך בלבד / הקפצה), replacing
// `TripShapeControl` + `CarAtDestinationToggle` in the request form. Writes `tripType`/
// `dropOffPickup` plus the legacy `tripShape`/`needsCarAtDestination`/`oneWayCarMode` fields
// together (`tripTypeToLegacyFields`) so every other consumer of those legacy fields keeps
// working unchanged (`ORIGINS_PLAN_2026-10.md` §5).
import { Controller, type Control, type UseFormReturn } from "react-hook-form";

import { FieldAnchor } from "@/components/FieldAnchor";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { he, t } from "@/i18n/he";
import { TRIP_TYPES, type TripType } from "@/lib/enums";
import { cn } from "@/lib/utils";

import { tripTypeToLegacyFields } from "../../tripType";
import type { RequestFormValues } from "../../schema";
import { useDropOffSwitch } from "./DropOffSwitch";

const LABEL_BY_TYPE: Record<TripType, string> = {
  round_trip: he.request.tripTypeRoundTrip,
  one_way: he.request.tripTypeOneWay,
  drop_off: he.request.tripTypeDropOff,
};

export interface TripTypeFieldsProps {
  control: Control<RequestFormValues>;
  form: UseFormReturn<RequestFormValues>;
  variant: "weekly" | "quick" | "carNow";
  tripType: TripType;
  dropOffPickup: boolean;
  /** `canUseDrivingTripTypes()` — false disables round_trip/one_way (REQ §13.88/§13.93). */
  canDrive: boolean;
  /** Sentence layout (§3.4a): bordered pills, the selected one tinted. */
  pill?: boolean;
  /** REQ §13.112 (e): switching to הקפצה uses plan B (route minutes need the department) or asks for it (the place list). */
  departmentId?: string;
  destinations?: readonly { id: string; name: string; aliases: string[]; zone?: string; is_drop_point?: boolean }[];
}

export function TripTypeFields({ control, form, variant, tripType, dropOffPickup, canDrive, pill, departmentId, destinations = [] }: TripTypeFieldsProps) {
  const dropOffSwitch = useDropOffSwitch({ form, variant, departmentId, destinations, anchored: !!pill });
  if (variant === "carNow") return null;

  function applyTripType(next: TripType, nextDropOffPickup: boolean) {
    const fields = tripTypeToLegacyFields(next, nextDropOffPickup);
    form.setValue("tripType", next, { shouldDirty: true });
    form.setValue("dropOffPickup", nextDropOffPickup, { shouldDirty: true });
    form.setValue("tripShape", fields.tripShape, { shouldDirty: true, shouldValidate: true });
    form.setValue("needsCarAtDestination", fields.needsCarAtDestination, { shouldDirty: true });
    form.setValue("oneWayCarMode", fields.oneWayCarMode, { shouldDirty: true });
  }

  return (
    <FieldAnchor name="tripType">
      <Controller
        control={control}
        name="tripType"
        render={({ field }) => (
          <ToggleGroup
            type="single"
            value={field.value}
            onValueChange={(next) => {
              if (!next) return;
              dropOffSwitch.select(next as TripType, (type) => applyTripType(type, type === "drop_off" ? dropOffPickup : false));
            }}
            className={cn("flex-wrap justify-start", pill && "gap-1.5")}
            aria-label={t("request.tripTypeRoundTrip")}
          >
            {TRIP_TYPES.map((type) => (
              <ToggleGroupItem
                key={type}
                value={type}
                disabled={type !== "drop_off" && !canDrive}
                className={cn("h-11 px-3 text-sm", pill && "h-8 rounded-full border data-[state=on]:border-primary data-[state=on]:bg-primary/10 data-[state=on]:font-medium data-[state=on]:text-primary")}
              >
                {LABEL_BY_TYPE[type]}
              </ToggleGroupItem>
            ))}
          </ToggleGroup>
        )}
      />
      {!canDrive ? <p className="text-sm text-muted-foreground">{he.request.nonDriverTripTypeHint}</p> : null}
      {tripType === "drop_off" ? (
        <div className="flex items-center justify-between gap-2 pt-2">
          <Label htmlFor="drop-off-pickup">{he.request.dropOffPickupToggle}</Label>
          <Switch
            id="drop-off-pickup"
            checked={dropOffPickup}
            onCheckedChange={(checked) => applyTripType("drop_off", checked)}
          />
        </div>
      ) : null}
      {dropOffSwitch.dialog}
    </FieldAnchor>
  );
}
