import { Fuel, Zap } from "lucide-react";

import { he } from "@/i18n/he";
import type { CarFuelType } from "@/lib/enums";
import { cn } from "@/lib/utils";

/** FU1 (REQ item 217): the car's fuel type — one of the facts a driver needs first, next to the licence plate. */
export function CarFuelChip({ fuel, className }: { fuel: CarFuelType | null | undefined; className?: string }) {
  if (!fuel) return null;
  const Icon = fuel === "electric" ? Zap : Fuel;
  return (
    <span
      className={cn("inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5 text-xs font-medium text-foreground", className)}
      data-testid="car-fuel"
    >
      <Icon className="size-3.5" aria-hidden="true" />
      {he.car.fuel[fuel]}
    </span>
  );
}
