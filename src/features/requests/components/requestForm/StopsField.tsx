// REQUIREMENTS §13.93 "Multi-stop rides", TODO ST1 rework: the classic form's stops entry — one
// "עצירות" button (with the count) that opens the shared stops editor (`StopsSheet`).
import { Plus } from "lucide-react";
import { useState } from "react";
import { useWatch, type UseFormReturn } from "react-hook-form";

import { tv, he } from "@/i18n/he";

import type { RequestFormValues } from "../../schema";
import type { PlaceOption } from "./sentence/PlacePicker";
import { StopsSheet } from "./StopsSheet";

export interface StopsFieldProps {
  form: UseFormReturn<RequestFormValues>;
  places: readonly PlaceOption[];
  /** The trip has a return leg (round trip, or הקפצה with a pickup). */
  hasReturn: boolean;
  /** First validation message of any stop (R3B21: stop equals origin/destination). */
  error?: string;
}

export function StopsField({ form, places, hasReturn, error }: StopsFieldProps) {
  const [open, setOpen] = useState(false);
  const [outStops, returnStops] = useWatch({ control: form.control, name: ["outStops", "returnStops"] });
  const count = (outStops?.length ?? 0) + (hasReturn ? (returnStops?.length ?? 0) : 0);
  return (
    <div className="space-y-1" data-field="outStops">
      <button
        type="button"
        className="inline-flex min-h-11 items-center gap-1 text-sm font-semibold text-primary hover:underline"
        data-testid="add-stop"
        onClick={() => setOpen(true)}
      >
        <Plus className="size-4" aria-hidden="true" />
        {count > 0 ? tv("request.stopsButtonCount", { count: String(count) }) : he.request.stopsButton}
      </button>
      {error ? <p role="alert" className="text-sm font-medium text-destructive">{error}</p> : null}
      <StopsSheet form={form} places={places} hasReturn={hasReturn} open={open} onOpenChange={setOpen} />
    </div>
  );
}
