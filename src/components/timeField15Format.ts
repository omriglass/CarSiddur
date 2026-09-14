export const MIN_MINUTES = 6 * 60;
export const MAX_MINUTES = 23 * 60 + 45; // 23:45

export function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

/** Parses `"HH:MM"` to minutes since midnight, or `null` if not well-formed. */
export function parseHHMM(value: string): number | null {
  const match = /^(\d{1,2}):(\d{2})$/.exec(value.trim());
  if (!match) return null;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (hours < 0 || hours > 23 || minutes < 0 || minutes > 59) return null;
  return hours * 60 + minutes;
}

export function formatMinutes(totalMinutes: number): string {
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return `${pad2(hours)}:${pad2(minutes)}`;
}

/**
 * Rounds `"HH:MM"` to the nearest 15-minute mark and clamps to `[min, max]`
 * (default 06:00–23:45). End fields may explicitly allow 23:59.
 * Returns `null` for unparsable
 * input so callers can revert instead of committing garbage.
 */
export function snapToQuarterHour(
  value: string,
  bounds: { min?: number; max?: number } = {},
): string | null {
  const parsed = parseHHMM(value);
  if (parsed === null) return null;
  const min = bounds.min ?? MIN_MINUTES;
  const max = bounds.max ?? MAX_MINUTES;
  if (parsed === 1439 && max === 1439) return "23:59";
  const rounded = Math.round(parsed / 15) * 15;
  return formatMinutes(Math.min(Math.max(rounded, min), max));
}
