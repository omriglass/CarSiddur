import { tv } from "@/i18n/he";

interface SiddurCar {
  name: string;
  access_code?: string | null;
  is_replaced?: boolean;
  replacement_code?: string | null;
}

/** The label's two parts, for a narrow grid header that keeps the code on its own line (owner 2026-11-23). */
export function siddurCarParts(car: SiddurCar): { name: string; replaced: boolean; code: string | null } {
  return {
    name: car.name,
    replaced: !!car.is_replaced,
    code: (car.is_replaced ? car.replacement_code : car.access_code) ?? null,
  };
}

/** Published car labels always use the currently active car's code; a car without one shows its name only (owner 2026-10-21). */
export function siddurCarName(car: SiddurCar | null | undefined): string {
  if (!car) return "";
  const { code } = siddurCarParts(car);
  const name = car.is_replaced ? tv("siddurCar.replacementName", { name: car.name }) : car.name;
  return code ? tv("siddurCar.withCode", { name, code: `\u2066${code}\u2069` }) : name;
}
