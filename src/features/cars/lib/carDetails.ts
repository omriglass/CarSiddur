import { he, tv } from "@/i18n/he";

import type { Passengers } from "@/solver";

/** CR1 (REQ item 257): the recommended tire pressure as typed in the car page editor. */
export interface TirePressureDraft {
  front: string;
  rear: string;
}

const psiOk = (text: string) => /^\d{2}$/.test(text.trim()) && Number(text) >= 10 && Number(text) <= 99;

/** Both empty (not set) or both a whole number 10–99 PSI (`cars_tire_pressure_ck`). */
export function tirePressureError({ front, rear }: TirePressureDraft): string | null {
  if (!front.trim() && !rear.trim()) return null;
  return psiOk(front) && psiOk(rear) ? null : he.adminCars.tirePressureBoth;
}

/** "קדמיים 32 · אחוריים 30 PSI", or null when not set. */
export function tirePressureLabel(front: number | null | undefined, rear: number | null | undefined): string | null {
  if (front == null && rear == null) return null;
  return tv("adminCars.tirePressureValue", { front: front?.toString() ?? "—", rear: rear?.toString() ?? "—" });
}

/** "5 מבוגרים · 3 מבוגרים + 2 מושבי בטיחות" — every seat configuration of a car on one line, most adults first. */
export function seatConfigSummary(configs: readonly Passengers[]): string | null {
  if (configs.length === 0) return null;
  const parts = (c: Passengers) => [
    `${c.adults} ${he.adminCars.quickCheckAdults}`,
    ...(c.childSeats ? [`${c.childSeats} ${he.adminCars.seatConfigColumnChildSeats}`] : []),
    ...(c.boosters ? [`${c.boosters} ${he.adminCars.seatConfigColumnBoosters}`] : []),
  ].join(" + ");
  return [...configs]
    .sort((a, b) => b.adults - a.adults || b.childSeats - a.childSeats || b.boosters - a.boosters)
    .map(parts)
    .join(" · ");
}
