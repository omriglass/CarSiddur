import { useEffect, useState } from "react";

import { formatTime } from "@/lib/time";

import { clampRideVertical } from "./weekGridGeometry";

function minutesNow(): number {
  const [h, m] = formatTime(new Date()).split(":").map(Number);
  return (h ?? 0) * 60 + (m ?? 0);
}

/**
 * Owner 2026-11-16: the current hour on today's grid - a thin, faint primary (purple) line drawn behind the rides
 * (they are see-through too). It keeps its own minute timer, so only the line re-renders, never the grid.
 */
export function WeekGridNowLine({ dayStartMinutes, dayEndMinutes }: { dayStartMinutes: number; dayEndMinutes: number }) {
  const [now, setNow] = useState(minutesNow);
  useEffect(() => {
    const timer = window.setTimeout(() => setNow(minutesNow()), (60 - new Date().getUTCSeconds()) * 1000 + 200);
    return () => window.clearTimeout(timer);
  }, [now]);
  if (now < dayStartMinutes || now > dayEndMinutes) return null;
  return (
    <div
      className="pointer-events-none absolute inset-x-0 h-px bg-primary/45"
      style={{ top: clampRideVertical(now, now, dayStartMinutes, dayEndMinutes).top }}
      data-testid="grid-now-line"
      aria-hidden="true"
    />
  );
}
