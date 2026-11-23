import type { CarFuelType } from "@/lib/enums";

/** REQ item 264: the plate of the car actually in use - the replacement's while replaced (none when it has none). */
export function activeCarPlate(car: { license_plate?: string | null; is_replaced?: boolean; replacement_plate?: string | null }): string | null {
  return (car.is_replaced ? car.replacement_plate : car.license_plate) ?? null;
}

/** REQ item 266: the fuel of the car actually in use. An empty replacement fuel is unknown, never the regular car's. */
export function activeCarFuel(car: { fuel_type?: CarFuelType | null; is_replaced?: boolean; replacement_fuel_type?: CarFuelType | null }): CarFuelType | null {
  return (car.is_replaced ? car.replacement_fuel_type : car.fuel_type) ?? null;
}

/**
 * CR1 (owner 2026-11-17, REQ item 257): an Israeli licence plate as people read it — 8 digits `xxx-xx-xxx`,
 * 7 digits `xx-xxx-xx`. The stored value is left as typed; anything else (letters, another length) shows as typed.
 * Dashes, spaces and dots in the stored value are ignored when counting digits.
 */
export function formatPlate(plate: string | null | undefined): string {
  const raw = (plate ?? "").trim();
  const digits = raw.replace(/[\s.\-–]/g, "");
  if (!/^\d+$/.test(digits)) return raw;
  if (digits.length === 8) return `${digits.slice(0, 3)}-${digits.slice(3, 5)}-${digits.slice(5)}`;
  if (digits.length === 7) return `${digits.slice(0, 2)}-${digits.slice(2, 5)}-${digits.slice(5)}`;
  return raw;
}
