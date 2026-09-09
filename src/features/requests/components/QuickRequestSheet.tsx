import { Sheet, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { PortalSheetContent } from "@/components/PortalSheetContent";
import { he } from "@/i18n/he";

import type { CarFreeWindow } from "@/features/siddur/freeWindows";

import { RequestForm, type QuickRequestAwayWindow, type QuickRequestCarOption } from "./RequestForm";

export type { QuickRequestAwayWindow, QuickRequestCarOption };

export interface QuickRequestSheetProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  departmentId: string;
  weekStart: string;
  /** `yyyy-MM-dd`, the day the slot/button belongs to. */
  day: string;
  /** "HH:MM", prefilled start (still editable). */
  initialStartTime: string;
  /** The car the sheet opened for — the row clicked, or the day-list's "next free" default. */
  initialCarId: string;
  /** Every shared car in the department, for the "another car is free" offer and the optional picker. */
  cars: readonly QuickRequestCarOption[];
  /** Phone "לוקח/ת רכב עכשיו" flow: lets the member change which car they're asking for. */
  showCarPicker?: boolean;
  /** Pre-computed per-car free windows for `day`'s displayed range (`features/siddur/freeWindows.ts`). */
  freeWindows: readonly CarFreeWindow[];
  /** Raw away-from-home windows, for the more specific "away" warning (a subset of what's already excluded from `freeWindows`). */
  awayWindows?: readonly QuickRequestAwayWindow[];
  now: Date;
}

/**
 * Bottom sheet chrome for the live-week "I'm taking this car" flow (UX_FLOWS.md §18) — the
 * form body itself is `RequestForm`'s `variant="quick"` (the same component the full
 * new/edit request page uses), so a field added to one appears in the other.
 *
 * Uses `PortalSheetContent` (not the raw `SheetContent`) so `TimeField15`'s and
 * `DestinationCombobox`'s own popovers portal into this sheet's own content node instead of
 * `document.body` — a modal Radix `Dialog` locks background touch-scroll to only its own
 * content subtree, and a popover portaled to `document.body` by default becomes a DOM
 * *sibling* of the sheet, not a descendant, so the lock blocks its touch-scroll outright
 * (found and fixed for `TimeField15` here rather than in `WeekGrid.tsx`, whose own drag
 * listeners are pointer-id-scoped and already cleaned up on every pointerup/cancel — not the
 * cause; the fix was later generalized into `PortalSheetContent`/`PortalDialogContent` once
 * every other Sheet/Dialog hosting one of these fields needed the identical fix).
 */
export function QuickRequestSheet({
  open,
  onOpenChange,
  departmentId,
  weekStart,
  day,
  initialStartTime,
  initialCarId,
  cars,
  showCarPicker,
  freeWindows,
  awayWindows = [],
  now,
}: QuickRequestSheetProps) {
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <PortalSheetContent side="bottom" className="max-h-[85dvh] overflow-y-auto overscroll-contain">
        <SheetHeader className="sr-only">
          <SheetTitle>{he.quickRequest.submit}</SheetTitle>
        </SheetHeader>
        <RequestForm
          key={`${initialCarId}:${day}:${initialStartTime}`}
          mode="new"
          variant="quick"
          departmentId={departmentId}
          weekStart={weekStart}
          slotPrefill={{ day, departTime: initialStartTime, carId: initialCarId }}
          quickContext={{ cars, freeWindows, awayWindows, showCarPicker, now }}
          onDone={() => onOpenChange(false)}
        />
      </PortalSheetContent>
    </Sheet>
  );
}
