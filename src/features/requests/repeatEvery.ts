import { he, tv } from "@/i18n/he";

/** REQ §13.159: a repeating request's gap in weeks. */
export const REPEAT_EVERY_WEEKS = [1, 2, 3, 4, 5, 6, 7, 8] as const;

/** "שבוע" / "שבועיים" / "3 שבועות" …; anything outside 1–8 reads as one week. */
export function repeatWeeksLabel(weeks: number | null | undefined): string {
  const known = REPEAT_EVERY_WEEKS.find((w) => w === weeks) ?? 1;
  if (known === 1) return he.request.repeatWeeksOne;
  if (known === 2) return he.request.repeatWeeksTwo;
  return tv("request.repeatWeeksMany", { n: String(known) });
}

/** "כל שבוע" / "כל שבועיים" / "כל 3 שבועות" … */
export function repeatEveryLabel(weeks: number | null | undefined): string {
  return tv("request.repeatEvery", { weeks: repeatWeeksLabel(weeks) });
}
