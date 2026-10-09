import { dateKey } from "@/lib/time";

/** Washed fewer than this many days ago: shiny and happy. */
export const MOOD_HAPPY_MAX_DAYS = 7;
/** Washed this many days ago or more (or never): dusty and sad. */
export const MOOD_SAD_MIN_DAYS = 21;

export type CarMood = "happy" | "ok" | "sad" | "never";

function dayNumber(key: string): number {
  const [y = 0, m = 1, d = 1] =key.split("-").map(Number);
  return Date.UTC(y, m - 1, d) / 86_400_000;
}

/** Whole Asia/Jerusalem calendar days between `from` and `now`. */
export function daysSince(from: Date | string, now: Date): number {
  return dayNumber(dateKey(now)) - dayNumber(dateKey(from));
}

/** Purely cosmetic mood of a car from its last wash (`now` is injected for testability). */
export function carMood(lastWashAt: Date | string | null | undefined, now: Date): CarMood {
  if (!lastWashAt) return "never";
  const days = daysSince(lastWashAt, now);
  if (days < MOOD_HAPPY_MAX_DAYS) return "happy";
  if (days < MOOD_SAD_MIN_DAYS) return "ok";
  return "sad";
}
