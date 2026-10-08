// REQ §13.112 (a)/(b): the writes behind the plan-B controls, shared by the sentence form's "אם אין רכב" line
// (`sentence/PlanBLine.tsx`) and the classic form's "+ תוכנית ב׳" section (`PlanBFields.tsx`) so both edit the
// same fields the same way (defaults on first use, "משם" = same place, pickup follows the drop time, B2 clears errors).
import type { UseFormReturn } from "react-hook-form";

import type { DestinationValue } from "@/components/DestinationCombobox";

import { defaultPlanB, pickupAfterArrivalMoved } from "../../planB";
import { isSamePlace, type RequestFormValues } from "../../schema";

const OPTIONS = { shouldDirty: true, shouldValidate: true } as const;
const ALT_FIELDS = ["altPlace", "altArriveBy", "altPickup", "altPickupAt", "altPickupPlace"] as const;

export function planBActions(form: UseFormReturn<RequestFormValues>) {
  const set = {
    fallback: (value: RequestFormValues["fallback"]) => form.setValue("fallback", value, OPTIONS),
    altPlace: (value: RequestFormValues["altPlace"]) => form.setValue("altPlace", value, OPTIONS),
    altArriveBy: (value: RequestFormValues["altArriveBy"]) => form.setValue("altArriveBy", value, OPTIONS),
    altPickup: (value: RequestFormValues["altPickup"]) => form.setValue("altPickup", value, OPTIONS),
    altPickupAt: (value: RequestFormValues["altPickupAt"]) => form.setValue("altPickupAt", value, OPTIONS),
    altPickupPlace: (value: RequestFormValues["altPickupPlace"]) => form.setValue("altPickupPlace", value, OPTIONS),
  };

  return {
    set,

    /** Switching to plan B fills the defaults the first time (an edit keeps what was stored); "אסתדר"/"בלי" clear its errors (R10B2). */
    choose(next: "none" | "alternative" | "manage") {
      set.fallback(next);
      if (next === "alternative") {
        const values = form.getValues();
        if (!values.altArriveBy) {
          const defaults = defaultPlanB({
            tripType: values.tripType ?? "round_trip",
            departTime: values.departTime,
            returnTime: values.returnTime,
            arriveByTime: values.arriveByTime,
            departAnchor: values.departAnchor ?? "leave",
          });
          set.altPlace(defaults.altPlace);
          set.altArriveBy(defaults.altArriveBy);
          set.altPickup(defaults.altPickup);
          set.altPickupAt(defaults.altPickupAt);
        }
      } else {
        form.clearErrors([...ALT_FIELDS]);
      }
    },

    pickPlace(next: DestinationValue) {
      set.altPlace(next);
    },

    /** Picking the drop place itself (or nothing) is the same as "משם". */
    pickPickupPlace(next: DestinationValue | undefined) {
      const place = form.getValues("altPlace") as DestinationValue | undefined;
      set.altPickupPlace(next && place && isSamePlace(next, place) ? undefined : next);
    },

    setPickup(on: boolean) {
      set.altPickup(on);
      if (!on) {
        set.altPickupAt(undefined);
        set.altPickupPlace(undefined);
        form.clearErrors(["altPickupAt", "altPickupPlace"]);
      } else if (!form.getValues("altPickupAt")) {
        const values = form.getValues();
        const defaults = defaultPlanB({ tripType: "round_trip", departTime: values.departTime, returnTime: values.returnTime, arriveByTime: values.arriveByTime, departAnchor: values.departAnchor ?? "leave" });
        set.altPickupAt(defaults.altPickupAt);
      }
    },

    /** Sets the drop time; a pickup it reached or passed moves along (R10U4). Returns the pickup's new time when it moved. */
    setArriveBy(next: string): string | null {
      const values = form.getValues();
      const previous = values.altArriveBy ?? next;
      set.altArriveBy(next);
      if (!values.altPickup) return null;
      const shifted = pickupAfterArrivalMoved(previous, next, values.altPickupAt);
      if (!shifted.moved) return null;
      set.altPickupAt(shifted.pickupAt);
      return shifted.pickupAt ?? null;
    },
  };
}
