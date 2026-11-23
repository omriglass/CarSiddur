import { useAllProfiles } from "@/features/admin/members/hooks";
import { he, tv } from "@/i18n/he";
import { carOwnerIds } from "@/lib/carOwners";
import { formatDayDate } from "@/lib/dayLabels";

import { useCarCareHistoryQuery, useCarQuery } from "../hooks";
import { joinNames } from "../lib/ownerNames";
import { CarFuelChip } from "./CarFuelChip";
import { activeCarPlate, formatPlate } from "@/lib/plate";

/**
 * The car at a glance (owner 2026-11-13), at the top of the siddur's and the board's car-name menu: licence plate,
 * fuel, whose car it is ("הרכב של …" for a private car, else "אחראי/ת רכב: …"), and the last wash (the urea fill is
 * shown on the car page only, owner 2026-11-13). Mounted only while the menu is open, so the reads run on demand.
 */
export function CarGlance({ carId }: { carId: string }) {
  const car = useCarQuery(carId).data;
  const care = useCarCareHistoryQuery(carId).data;
  const profiles = useAllProfiles().data;
  // R20B11: until the names are in, a car with an owner or a responsible person would read "אין בעלים" / nobody.
  const needsNames = !!car && (car.type === "temporary" ? carOwnerIds(car).length > 0 : !!car.responsible_id);
  if (!car || (needsNames && !profiles)) return <p className="px-2 py-1.5 text-xs text-muted-foreground">{he.carPage.glanceLoading}</p>;

  const nameOf = (id: string | null) => (id ? profiles?.find((p) => p.id === id)?.full_name ?? "" : "");
  const lastAt = (kind: string) => care?.find((event) => event.kind === kind)?.created_at ?? null;
  // PC1 (REQ item 227 e): every owner of a private car ("הרכב של X וY"); an ownerless private car says so.
  const owners = car.type === "temporary" ? joinNames(carOwnerIds(car).map((id) => nameOf(id))) : "";
  const responsible = nameOf(car.responsible_id);
  const lastWash = lastAt("wash");

  return (
    <div className="space-y-1 px-2 py-1.5 text-xs" data-testid="car-glance">
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="font-medium" dir="ltr">{formatPlate(activeCarPlate(car))}</span>
        <CarFuelChip fuel={car.fuel_type} />
      </div>
      {owners ? <p>{tv("carPage.glanceOwner", { name: owners })}</p>
        : car.type === "temporary" ? <p>{he.carPage.glanceNoOwner}</p>
        : responsible ? <p>{tv("carPage.glanceResponsible", { name: responsible })}</p> : null}
      {lastWash ? <p className="text-muted-foreground">{tv("carPage.mood.lastWash", { date: formatDayDate(lastWash) })}</p> : null}
    </div>
  );
}
