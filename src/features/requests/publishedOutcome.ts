import { dateKey } from "@/lib/time";
import type { RideLeg } from "@/lib/enums";
import type { RequestWindow } from "./window";

/**
 * REQ §13.109 (a): a member sees a placement outcome only on a PUBLISHED day. Mirrors SQL
 * `is_day_public(dept, week_start, day)`: the week's phase is published/live/archived AND the
 * day is in `weeks.published_days`. Until then the request reads "submitted — waiting for the
 * siddur", whatever the planning board holds. One rule for every member surface (`mapRow` in
 * `api.ts` applies it, so rows, Home counts and the detail all agree).
 */
export function isRequestDayPublished(
  window: RequestWindow | null | undefined,
  departAt: string | null,
  returnAt: string | null,
): boolean {
  if (!window || !["published", "live", "archived"].includes(window.phase)) return false;
  const instant = departAt ?? returnAt;
  if (!instant) return false;
  return (window.published_days ?? []).includes(dateKey(instant));
}

/** Statuses that are a planning outcome (hidden before publication). `proposed` is an explicit message to the member and stays visible. */
const OUTCOME_STATUSES = new Set(["assigned", "merged", "waitlisted", "denied", "external"]);

export function isHiddenOutcome(status: string, published: boolean): boolean {
  return !published && OUTCOME_STATUSES.has(status);
}

export interface PlacedLeg {
  leg: RideLeg;
  startsAt: string;
  endsAt: string;
}

/** Per-leg coverage of a request that has both an out and a return leg (R6B12, R7B8-3). `null` = single-leg request or nothing to say. */
export function legCoverage(
  legs: readonly PlacedLeg[],
  hasOut: boolean,
  hasReturn: boolean,
): { out: boolean; ret: boolean } | null {
  if (!hasOut || !hasReturn) return null;
  return {
    out: legs.some((l) => l.leg === "out" || l.leg === "both"),
    ret: legs.some((l) => l.leg === "return" || l.leg === "both"),
  };
}

/** True when exactly one of the two legs is placed. */
export function isPartiallyPlaced(coverage: { out: boolean; ret: boolean } | null): boolean {
  return !!coverage && coverage.out !== coverage.ret;
}

/** The member's own times: out leg starts with the ride that carries it, return leg ends with the ride that carries it (R7B8-2). */
export function ownTimesFromLegs(
  legs: readonly PlacedLeg[],
): { departAt: string | null; returnAt: string | null } {
  const out = legs.find((l) => l.leg === "out" || l.leg === "both");
  const ret = legs.find((l) => l.leg === "return" || l.leg === "both");
  return { departAt: out?.startsAt ?? null, returnAt: ret?.endsAt ?? null };
}
