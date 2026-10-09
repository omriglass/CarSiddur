import { Card, CardContent } from "@/components/ui/card";
import { he, tv } from "@/i18n/he";
import { formatDayDate } from "@/lib/dayLabels";

import { carMood, type CarMood } from "../lib/carMood";

const FACE: Record<CarMood, { mouth: string; brows: boolean; tone: string }> = {
  happy: { mouth: "M22 40 Q32 49 42 40", brows: false, tone: "text-available" },
  ok: { mouth: "M24 42 L40 42", brows: false, tone: "text-primary" },
  never: { mouth: "M24 44 Q32 38 40 44", brows: true, tone: "text-muted-foreground" },
  sad: { mouth: "M24 44 Q32 38 40 44", brows: true, tone: "text-maintenance" },
};

/** Cosmetic car face; mood follows the last wash. Decorative (aria-hidden), the text carries the meaning. */
function CarFace({ mood }: { mood: CarMood }) {
  const face = FACE[mood];
  return (
    <svg viewBox="0 0 64 64" className={`size-14 shrink-0 ${face.tone} ${mood === "happy" ? "motion-safe:animate-pulse" : ""}`} aria-hidden="true">
      <path d="M8 40 L14 24 Q16 20 22 20 H42 Q48 20 50 24 L56 40 V50 H8 Z" fill="currentColor" fillOpacity="0.15" stroke="currentColor" strokeWidth="2" strokeLinejoin="round" />
      <circle cx="12" cy="50" r="5" fill="currentColor" />
      <circle cx="52" cy="50" r="5" fill="currentColor" />
      <circle cx="24" cy="32" r="2.5" fill="currentColor" />
      <circle cx="40" cy="32" r="2.5" fill="currentColor" />
      {face.brows ? <path d="M20 27 L28 29 M44 27 L36 29" stroke="currentColor" strokeWidth="2" strokeLinecap="round" /> : null}
      <path d={face.mouth} fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" />
      {mood === "happy" ? (
        <path d="M56 8 v8 M52 12 h8 M8 10 v6 M5 13 h6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
      ) : null}
    </svg>
  );
}

/** `/cars/:carId` mood card (UX_FLOWS.md car page). Purely cosmetic; reads the already-loaded wash history. */
export function CarMoodCard({ lastWashAt, now = new Date() }: { lastWashAt: string | null; now?: Date }) {
  const mood = carMood(lastWashAt, now);
  const date = lastWashAt ? formatDayDate(lastWashAt) : "";
  const text =
    mood === "never"
      ? he.carPage.mood.never
      : mood === "sad"
        ? he.carPage.mood.sad
        : tv(mood === "happy" ? "carPage.mood.happy" : "carPage.mood.ok", { date });
  return (
    <Card className="bg-gradient-card shadow-card" data-testid="car-mood-card" data-mood={mood}>
      <CardContent className="flex items-center gap-3 p-3 text-sm">
        <CarFace mood={mood} />
        <div className="space-y-0.5">
          <p className="font-medium">{text}</p>
          {mood === "sad" && lastWashAt ? (
            <p className="text-xs text-muted-foreground">{tv("carPage.mood.lastWash", { date })}</p>
          ) : null}
        </div>
      </CardContent>
    </Card>
  );
}
