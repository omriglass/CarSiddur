import { CarFront, ChevronDown } from "lucide-react";
import type { ReactNode } from "react";
import { useState } from "react";

import { CarMenu, type CarMenuCar } from "@/components/CarMenu";
import { CarReportDialog } from "@/features/carCare/components/CarReportDialog";
import { he, tv } from "@/i18n/he";

export interface DayCarsStripProps {
  cars: readonly CarMenuCar[];
  /** The car at a glance on top of each menu. */
  renderCarGlance?: (carId: string) => ReactNode;
  /** Swapping two cars' rides is allowed on the shown day. */
  canSwap?: boolean;
  onCarSwap?: (carA: string, carB: string) => void;
  /** Offer "דיווח / טיפול ברכב". */
  enableCarReport?: boolean;
  onOpenCarPage?: (carId: string) => void;
}

/**
 * R20U2 (QA run 20): the card view's way to the car-name menu, which the table has on its car header. One chip per car
 * of the day (the same cars the table's header shows), scrolling sideways; a tap opens the same menu.
 */
export function DayCarsStrip({ cars, renderCarGlance, canSwap = false, onCarSwap, enableCarReport = false, onOpenCarPage }: DayCarsStripProps) {
  const [menuCarId, setMenuCarId] = useState<string | null>(null);
  const [reportCarId, setReportCarId] = useState<string | null>(null);
  if (cars.length === 0) return null;
  const reportCar = cars.find((car) => car.id === reportCarId);
  return (
    <div className="-mx-1 flex gap-1.5 overflow-x-auto px-1 pb-1" role="group" aria-label={he.carSwap.dayCarsLabel} data-testid="day-cars-strip">
      {cars.map((car) => (
        <CarMenu
          key={car.id}
          car={car}
          open={menuCarId === car.id}
          onOpenChange={(open) => setMenuCarId(open ? car.id : null)}
          glance={renderCarGlance?.(car.id)}
          swapTargets={canSwap ? cars.filter((other) => other.id !== car.id) : []}
          onSwap={onCarSwap}
          onReport={enableCarReport ? setReportCarId : undefined}
          onOpenCarPage={onOpenCarPage}
        >
          <button
            type="button"
            className="flex min-h-9 shrink-0 items-center gap-1 rounded-full border bg-card px-3 text-sm hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            aria-label={tv("carSwap.carMenuLabel", { car: car.name })}
            data-testid="day-car-chip"
          >
            <CarFront className="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
            <span className="whitespace-nowrap">{car.name}</span>
            <ChevronDown className="size-3 shrink-0 text-muted-foreground" aria-hidden="true" />
          </button>
        </CarMenu>
      ))}
      {reportCar ? <CarReportDialog carId={reportCar.id} carName={reportCar.name} open onOpenChange={(open) => { if (!open) setReportCarId(null); }} /> : null}
    </div>
  );
}
