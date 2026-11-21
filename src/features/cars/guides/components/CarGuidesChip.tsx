import { useState } from "react";

import { he } from "@/i18n/he";

import { CarGuidesDialog } from "./CarGuidesBody";

/** REQ item 259: "איך עושים…" one tap away on /my — a chip on my ride's card that opens the car's guides. */
export function CarGuidesChip({ carId }: { carId: string }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        type="button"
        className="rounded bg-primary/10 px-1 font-medium text-primary hover:underline"
        onClick={(event) => { event.stopPropagation(); setOpen(true); }}
        onKeyDown={(event) => event.stopPropagation()}
        data-testid="ride-car-guides"
      >
        {he.carGuides.chip}
      </button>
      {/* Clicks inside the dialog must not reach the card behind it. */}
      <span onClick={(event) => event.stopPropagation()} onKeyDown={(event) => event.stopPropagation()}>
        <CarGuidesDialog carId={carId} open={open} onOpenChange={setOpen} />
      </span>
    </>
  );
}
