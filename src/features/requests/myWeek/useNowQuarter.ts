import { useEffect, useState } from "react";

import { minutesOfDay } from "./dayColumns";

/** The Asia/Jerusalem quarter hour "now" falls in, as minutes since midnight (07:58 → 465 = 07:45). */
export function quarterOf(instant: Date): number {
  return Math.floor(minutesOfDay(instant) / 15) * 15;
}

/**
 * `quarterOf(now)`, re-rendering when the next quarter starts (owner 2026-10-13: the week view's
 * hour column marks the current quarter). A timer to the boundary, not a tick every minute.
 */
export function useNowQuarter(): number {
  const [quarter, setQuarter] = useState(() => quarterOf(new Date()));
  useEffect(() => {
    const now = new Date();
    const msIntoQuarter = ((minutesOfDay(now) % 15) * 60 + now.getUTCSeconds()) * 1000 + now.getUTCMilliseconds();
    const timer = window.setTimeout(() => setQuarter(quarterOf(new Date())), 15 * 60_000 - msIntoQuarter + 500);
    return () => window.clearTimeout(timer);
  }, [quarter]);
  return quarter;
}
