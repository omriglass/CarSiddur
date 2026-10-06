import { tv } from "@/i18n/he";

interface SiddurCar {
  name: string;
  /** The code-missing hint is shown for shared cars only; private/temporary cars never get it (R2B14). */
  type?: string | null;
  access_code?: string | null;
  is_replaced?: boolean;
  replacement_code?: string | null;
}

/** Published car labels always use the currently active car's code. */
export function siddurCarName(car: SiddurCar | null | undefined): string {
  if (!car) return "";
  const name = car.is_replaced ? tv("siddurCar.replacementName", { name: car.name }) : car.name;
  const code = car.is_replaced ? car.replacement_code : car.access_code;
  if (code) return tv("siddurCar.withCode", { name, code: `\u2066${code}\u2069` });
  return car.type === "shared" ? tv("siddurCar.withoutCode", { name }) : name;
}
