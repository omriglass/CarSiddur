// REQ §13.112 (e), UX_FLOWS §3.4a "Switching to הקפצה": choosing the הקפצה trip type on a weekly הלוך-חזור / הלוך בלבד.
//  - with a plan B: the request becomes that הקפצה (drop place, "be there by", pickup) and the previous main trip +
//    plan B are kept in form state (`mainTripBackup`), so switching back restores both exactly (REQ §13.97);
//  - without one: a dialog asks for the details as one sentence, then does the same.
// Shared by both layouts through `TripTypeFields`.
import { useState, type ReactNode } from "react";
import type { UseFormReturn } from "react-hook-form";
import { toast } from "sonner";

import type { DestinationValue } from "@/components/DestinationCombobox";

import { tv } from "@/i18n/he";
import type { TripType } from "@/lib/enums";

import { useRouteMinutesFetcher } from "../../hooks";
import {
  dropOffCarTimes,
  dropOffFromPlanBPatch,
  droppedPickupPlace,
  planBDetails,
  planBOffered,
  restoreMainTripPatch,
  snapshotMainTrip,
  type PlanBDetails,
} from "../../planB";
import { destinationValueToPoint } from "../../routePoints";
import type { RequestFormValues } from "../../schema";
import { DropOffSwitchDialog } from "./DropOffSwitchDialog";

const ALT_FIELDS = ["altPlace", "altArriveBy", "altPickup", "altPickupAt", "altPickupPlace"] as const;

function placeName(value: DestinationValue | null | undefined): string {
  if (!value) return "";
  return "presetId" in value ? value.name : value.freeText;
}

interface UseDropOffSwitchOptions {
  form: UseFormReturn<RequestFormValues>;
  variant: "weekly" | "quick" | "carNow";
  departmentId?: string;
  destinations: readonly { id: string; name: string; aliases: string[]; zone?: string; is_drop_point?: boolean }[];
  /** Sentence layout: the anchors derive the car times; classic sets them from the fetched route minutes. */
  anchored: boolean;
}

/**
 * `select(next, pickup, applyPlain)` handles a trip-type choice: it returns `true` when it took over (plan-B
 * switch, restore, or the dialog), `false` when the caller should apply the plain change itself.
 */
export function useDropOffSwitch({ form, variant, departmentId, destinations, anchored }: UseDropOffSwitchOptions): {
  select: (next: TripType, applyPlain: (next: TripType) => void) => void;
  dialog: ReactNode;
} {
  const [dialogOpen, setDialogOpen] = useState(false);
  const fetchMinutes = useRouteMinutesFetcher(departmentId);

  function patch(values: Partial<RequestFormValues>) {
    for (const [key, value] of Object.entries(values)) {
      form.setValue(key as keyof RequestFormValues, value as never, { shouldDirty: true, shouldValidate: key === "tripShape" });
    }
  }

  async function switchToPlan(plan: PlanBDetails) {
    const current = form.getValues();
    patch(dropOffFromPlanBPatch(plan, anchored));
    form.setValue("mainTripBackup", current.mainTripBackup ?? snapshotMainTrip(current), { shouldDirty: true });
    form.clearErrors([...ALT_FIELDS]);
    const dropped = droppedPickupPlace(plan);
    if (dropped) toast(tv("planB.switch.pickupPlaceKept", { place: placeName(plan.place), pickupPlace: placeName(dropped) }));
    if (anchored) return;
    // Classic: no anchors, so the car times come from the two drives (REQ §13.109: unknown = 60 minutes).
    const origin = current.origin;
    const [outMinutes, returnMinutes] = await Promise.all([
      fetchMinutes([origin, plan.place].map(destinationValueToPoint)),
      plan.pickup ? fetchMinutes([plan.place, origin].map(destinationValueToPoint)) : Promise.resolve(0),
    ]);
    const times = dropOffCarTimes(plan, { outMinutes, returnMinutes });
    form.setValue("departTime", times.departTime, { shouldDirty: true, shouldValidate: true });
    if (times.returnTime) form.setValue("returnTime", times.returnTime, { shouldDirty: true, shouldValidate: true });
  }

  function restore(next: TripType, applyPlain: (next: TripType) => void) {
    const backup = form.getValues("mainTripBackup");
    if (!backup) return;
    patch(restoreMainTripPatch(backup));
    form.setValue("mainTripBackup", undefined, { shouldDirty: true });
    form.clearErrors([...ALT_FIELDS]);
    if (next !== backup.tripType) applyPlain(next);
  }

  function select(next: TripType, applyPlain: (next: TripType) => void) {
    const values = form.getValues();
    if (variant === "weekly" && values.mainTripBackup && next !== "drop_off") {
      restore(next, applyPlain);
      return;
    }
    if (variant === "weekly" && next === "drop_off" && values.tripType !== "drop_off" && planBOffered(values)) {
      const plan = planBDetails(values);
      if (plan) void switchToPlan(plan);
      else setDialogOpen(true);
      return;
    }
    applyPlain(next);
  }

  const dialog = dialogOpen ? (
    <DropOffSwitchDialog
      values={form.getValues()}
      destinations={destinations}
      onCancel={() => setDialogOpen(false)}
      onConfirm={(plan) => {
        setDialogOpen(false);
        void switchToPlan(plan);
      }}
    />
  ) : null;

  return { select, dialog };
}
