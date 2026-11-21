import { ChevronDown } from "lucide-react";
import type { ReactNode } from "react";
import { useState } from "react";

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { CarGuidesDialog } from "@/features/cars/guides/components/CarGuidesBody";
import { useCarGuidesQuery } from "@/features/cars/guides/hooks";
import { he, tv } from "@/i18n/he";
import { cn } from "@/lib/utils";

export interface CarMenuCar {
  id: string;
  name: string;
}

export interface CarMenuProps {
  car: CarMenuCar;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The trigger element (rendered `asChild`). */
  children: ReactNode;
  /** The car at a glance (REQ item 226 c), on top. */
  glance?: ReactNode;
  /** The cars this one may swap with on the shown day; none = no "החלפה עם…". */
  swapTargets?: readonly CarMenuCar[];
  onSwap?: (carA: string, carB: string) => void;
  onReport?: (carId: string) => void;
  onOpenCarPage?: (carId: string) => void;
}

/**
 * The car-name menu (REQ §13.122 e, item 226 c): the car at a glance, "החלפה עם…", "דיווח / טיפול ברכב", "איך עושים…"
 * (REQ item 259, when the car has guides), "דף הרכב".
 * One component for the table's car header and the card view's car row (R20U2, QA run 20). "החלפה עם…" opens its list
 * inside the menu (R20U1): a side submenu next to the menu does not fit at phone width.
 */
export function CarMenu({ car, open, onOpenChange, children, glance, swapTargets = [], onSwap, onReport, onOpenCarPage }: CarMenuProps) {
  const [swapListOpen, setSwapListOpen] = useState(false);
  const [guidesOpen, setGuidesOpen] = useState(false);
  const canSwap = swapTargets.length > 0 && !!onSwap;
  return (
    <>
    <DropdownMenu open={open} onOpenChange={(next) => { if (!next) setSwapListOpen(false); onOpenChange(next); }}>
      <DropdownMenuTrigger asChild>{children}</DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="min-w-56 max-w-[calc(100vw-2rem)]">
        {glance ? (
          <>
            <div data-testid="week-grid-car-glance">{glance}</div>
            <DropdownMenuSeparator />
          </>
        ) : null}
        {canSwap ? (
          <>
            <DropdownMenuItem
              data-testid="car-swap-submenu"
              aria-expanded={swapListOpen}
              onSelect={(e) => {
                e.preventDefault();
                setSwapListOpen((cur) => !cur);
              }}
            >
              <span className="flex-1">{he.carSwap.swapWithMenu}</span>
              <ChevronDown className={cn("size-3.5 shrink-0 text-muted-foreground transition-transform", swapListOpen && "rotate-180")} aria-hidden="true" />
            </DropdownMenuItem>
            {swapListOpen ? (
              <div className="ms-2 max-h-[40dvh] overflow-y-auto border-s-2 border-s-border" data-testid="car-swap-list">
                {swapTargets.map((other) => (
                  <DropdownMenuItem key={other.id} onSelect={() => onSwap?.(car.id, other.id)}>
                    {tv("carSwap.swapWithCar", { car: other.name })}
                  </DropdownMenuItem>
                ))}
              </div>
            ) : null}
          </>
        ) : null}
        {canSwap && (onReport || onOpenCarPage) ? <DropdownMenuSeparator /> : null}
        {onReport ? (
          <DropdownMenuItem data-testid="car-name-report-menu-item" onSelect={() => onReport(car.id)}>
            {he.carSwap.carReportItem}
          </DropdownMenuItem>
        ) : null}
        {onReport ? <CarGuidesMenuItem carId={car.id} onOpen={() => setGuidesOpen(true)} /> : null}
        {onOpenCarPage ? (
          <DropdownMenuItem data-testid="car-page-menu-item" onSelect={() => onOpenCarPage(car.id)}>
            {he.carSwap.carPageItem}
          </DropdownMenuItem>
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
    {guidesOpen ? <CarGuidesDialog carId={car.id} open onOpenChange={setGuidesOpen} /> : null}
    </>
  );
}

/** REQ item 259: "איך עושים…" in the car menu, only when the car has guides (asked only while the menu is open). */
function CarGuidesMenuItem({ carId, onOpen }: { carId: string; onOpen: () => void }) {
  const guides = useCarGuidesQuery(carId).data ?? [];
  if (!guides.length) return null;
  return (
    <DropdownMenuItem data-testid="car-guides-menu-item" onSelect={onOpen}>
      {he.carGuides.entryTitle}
    </DropdownMenuItem>
  );
}
