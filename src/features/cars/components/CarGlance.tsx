import { useAllProfiles } from "@/features/admin/members/hooks";
import { he, tv } from "@/i18n/he";
import { formatDayDate } from "@/lib/dayLabels";

import { useCarCareHistoryQuery, useCarQuery } from "../hooks";
import { CarFuelChip } from "./CarFuelChip";

/**
 * The car at a glance (owner 2026-11-13), at the top of the siddur's and the board's car-name menu: licence plate,
 * fuel, whose car it is ("הרכב של …" for a private car, else "אחראי/ת רכב: …"), the last wash and — on a diesel
 * car — the last urea fill. Mounted only while the menu is open, so the reads run on demand.
 */
export function CarGlance({ carId, showUrea = true }: { carId: string; /** Off on the board (owner 2026-11-13). */ showUrea?: boolean }) {
  const car = useCarQuery(carId).data;
  const care = useCarCareHistoryQuery(carId).data;
  const profiles = useAllProfiles().data;
  if (!car) return <p className="px-2 py-1.5 text-xs text-muted-foreground">{he.carPage.glanceLoading}</p>;

  const nameOf = (id: string | null) => (id ? profiles?.find((p) => p.id === id)?.full_name ?? "" : "");
  const lastAt = (kind: string) => care?.find((event) => event.kind === kind)?.created_at ?? null;
  const owner = car.type === "temporary" ? nameOf(car.owner_id) : "";
  const responsible = nameOf(car.responsible_id);
  const lastWash = lastAt("wash");
  const lastUrea = lastAt("urea_fill");

  return (
    <div className="space-y-1 px-2 py-1.5 text-xs" data-testid="car-glance">
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="font-medium" dir="ltr">{car.license_plate}</span>
        <CarFuelChip fuel={car.fuel_type} />
      </div>
      {owner ? <p>{tv("carPage.glanceOwner", { name: owner })}</p> : responsible ? <p>{tv("carPage.glanceResponsible", { name: responsible })}</p> : null}
      {lastWash ? <p className="text-muted-foreground">{tv("carPage.mood.lastWash", { date: formatDayDate(lastWash) })}</p> : null}
      {showUrea && car.fuel_type === "diesel" ? (
        <p className="text-muted-foreground" data-testid="car-glance-urea">
          {lastUrea ? tv("carPage.lastUreaFill", { date: formatDayDate(lastUrea) }) : he.carPage.lastUreaNever}
        </p>
      ) : null}
    </div>
  );
}
