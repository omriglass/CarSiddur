// REQ §13.126 (g), UX_FLOWS §3.4a "הרכב זמין לשימוש ביעד": the optional line under the sentence of a driver's
// single-day הלוך-חזור — a small link that turns into "הרכב מחכה ב<יעד> ופנוי למי שיוצא/ת משם; אני חוזר/ת איתו" with an ×.
// Writes the form field `keepCarAtDestination` only; the member never sees the word "הקפצה".
import { X } from "lucide-react";
import type { UseFormReturn } from "react-hook-form";

import { he, tv } from "@/i18n/he";

import type { RequestFormValues } from "../../../schema";

interface KeepCarLineProps {
  form: UseFormReturn<RequestFormValues>;
  on: boolean;
  /** The destination's name; empty while none is chosen (a placeholder shows). */
  destinationName: string;
}

export function KeepCarLine({ form, on, destinationName }: KeepCarLineProps) {
  const set = (next: boolean) => form.setValue("keepCarAtDestination", next, { shouldDirty: true });
  if (!on) {
    return (
      <button
        type="button"
        className="relative text-sm text-primary before:absolute before:-inset-2 before:content-[''] hover:underline"
        onClick={() => set(true)}
        data-testid="keep-car-link"
      >
        {he.keepCar.link}
      </button>
    );
  }
  return (
    <div className="flex flex-wrap items-center gap-x-1.5 gap-y-1 text-base leading-8" data-testid="keep-car-line">
      <span>{tv("keepCar.line", { place: destinationName || he.keepCar.placeEmpty })}</span>
      <button
        type="button"
        className="relative inline-flex size-6 items-center justify-center rounded-full text-muted-foreground before:absolute before:-inset-2 before:content-[''] hover:bg-accent hover:text-foreground"
        aria-label={he.keepCar.remove}
        onClick={() => set(false)}
        data-testid="keep-car-remove"
      >
        <X className="size-4" aria-hidden="true" />
      </button>
    </div>
  );
}
