const KM_FORMAT = new Intl.NumberFormat("en-US");

/** Largest odometer value the database accepts (`car_odometer_readings_km_ck`). */
export const MAX_KM = 9_999_999;

/** "123,456" — thousands separators for an odometer value. */
export function formatKm(km: number): string {
  return KM_FORMAT.format(km);
}

/**
 * Parses what a member typed in the kilometrage field: a whole number, thousands separators and spaces
 * tolerated; anything else (empty, decimals, letters, over `MAX_KM`) is `null`.
 */
export function parseKm(text: string): number | null {
  const cleaned = text.trim().replace(/[,\s]/g, "");
  if (!/^\d{1,7}$/.test(cleaned)) return null;
  const value = Number(cleaned);
  return value <= MAX_KM ? value : null;
}
