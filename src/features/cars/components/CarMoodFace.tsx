import { he, tv } from "@/i18n/he";
import { formatDayDate } from "@/lib/dayLabels";

import { carMood, type CarMood } from "../lib/carMood";

const FACE: Record<CarMood, { mouth: string; brows: boolean; tone: string }> = {
  happy: { mouth: "M22 40 Q32 49 42 40", brows: false, tone: "text-available" },
  ok: { mouth: "M24 42 L40 42", brows: false, tone: "text-primary" },
  never: { mouth: "M24 44 Q32 38 40 44", brows: true, tone: "text-muted-foreground" },
  sad: { mouth: "M24 44 Q32 38 40 44", brows: true, tone: "text-maintenance" },
};

/**
 * REQ item 264: the wash status in the car page's header - a tiny car face coloured by the last wash, with no date
 * on screen (the wording is for screen readers). Reporting a wash is the "שטיפת רכב" row under "דיווחים".
 */
export function CarMoodFace({ lastWashAt, now = new Date() }: { lastWashAt: string | null; now?: Date }) {
  const mood = carMood(lastWashAt, now);
  const face = FACE[mood];
  const label =
    mood === "never"
      ? he.carPage.mood.never
      : mood === "sad"
        ? he.carPage.mood.sad
        : tv(mood === "happy" ? "carPage.mood.happy" : "carPage.mood.ok", { date: lastWashAt ? formatDayDate(lastWashAt) : "" });
  return (
    <svg viewBox="0 0 64 64" role="img" aria-label={label} data-testid="car-mood" data-mood={mood} className={`size-5 shrink-0 ${face.tone}`}>
      <path d="M8 40 L14 24 Q16 20 22 20 H42 Q48 20 50 24 L56 40 V50 H8 Z" fill="currentColor" fillOpacity="0.15" stroke="currentColor" strokeWidth="3" strokeLinejoin="round" />
      <circle cx="12" cy="50" r="5" fill="currentColor" />
      <circle cx="52" cy="50" r="5" fill="currentColor" />
      <circle cx="24" cy="32" r="3" fill="currentColor" />
      <circle cx="40" cy="32" r="3" fill="currentColor" />
      {face.brows ? <path d="M20 27 L28 29 M44 27 L36 29" stroke="currentColor" strokeWidth="3" strokeLinecap="round" /> : null}
      <path d={face.mouth} fill="none" stroke="currentColor" strokeWidth="3.5" strokeLinecap="round" />
    </svg>
  );
}
