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
