// CM1 phase 2 (REQ item 260 b): the same person's two trips one after the other merge into one chained ride. The
// server (`_merge_check` -> `merge_preview` / `member_merge_preview`) decides and sends the chain; these read it.
import { joinNames } from "@/features/cars/lib/ownerNames";
import { tv } from "@/i18n/he";

export type ChainRoute = { leg: "out" | "return"; placeId: string | null; name: string }[];

/** CM1 phase 3: one answer to "the people on one trip only" - its route and the time they get on (before) / off (after). */
export interface ChainVariant {
  route: ChainRoute;
  at: string | null;
  /** Its driving is within the department's detour limit (an answer over it is not offered). */
  ok: boolean;
}

/**
 * CM1 phase 3 (REQ item 260 c): the long trip's people who are not on the short trip - they ride the whole chained ride
 * (`plain`) or the ride passes the start place again for them (`via`: picked up there / dropped there on the way).
 */
export interface ChainOneTrip {
  names: string[];
  unnamed: number;
  /** The shared start place ("נבו"). */
  place: string;
  /** Their own time before the merge: departure (before) / return (after). */
  was: string | null;
  plain: ChainVariant;
  via: ChainVariant;
}

/** CM1 phase 2: a chained merge - which trip rides first and the one ride's places in order. */
export interface MergeChain {
  side: "before" | "after" | "before_via" | "after_via";
  /** The chained (short) trip's request; the other one is the route base. */
  requestId: string;
  baseRequestId: string;
  route: ChainRoute;
  /** CM1 phase 3: someone is on one trip only - asked in the popup; null = nothing to ask. */
  oneTrip: ChainOneTrip | null;
}

/** The chain rides first (its people get on at the start) - `before` / `before_via`. */
export function chainFirst(chain: Pick<MergeChain, "side">): boolean {
  return chain.side.startsWith("before");
}

/** "נבו ← בית ספר ← חיפה ← נבו": the chained ride's places once each in order (the way back starts where the way there ends). */
export function chainRouteText(chain: Pick<MergeChain, "route">): string {
  const out = chain.route.filter((p) => p.leg === "out");
  const back = chain.route.filter((p) => p.leg === "return");
  return [...out, ...(out.length ? back.slice(1) : back)].map((p) => p.name).join(" ← ");
}

const SIDES = ["before", "after", "before_via", "after_via"] as const;

function parseRoute(raw: unknown): ChainRoute {
  return Array.isArray(raw) ? raw.flatMap((p): ChainRoute => {
    const row = p as Record<string, unknown>;
    return row.leg === "out" || row.leg === "return"
      ? [{ leg: row.leg, placeId: typeof row.place_id === "string" ? row.place_id : null, name: typeof row.name === "string" ? row.name : "" }] : [];
  }) : [];
}

function parseVariant(raw: unknown): ChainVariant | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const v = raw as Record<string, unknown>;
  return { route: parseRoute(v.route), at: typeof v.at === "string" ? v.at : null, ok: v.ok !== false };
}

function parseOneTrip(raw: unknown): ChainOneTrip | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const o = raw as Record<string, unknown>;
  const plain = parseVariant(o.plain);
  const via = parseVariant(o.via);
  if (!plain || !via) return null;
  return {
    names: Array.isArray(o.names) ? o.names.filter((n): n is string => typeof n === "string") : [],
    unnamed: typeof o.unnamed === "number" ? o.unnamed : 0,
    place: typeof o.place === "string" ? o.place : "",
    was: typeof o.was === "string" ? o.was : null,
    plain, via,
  };
}

export function parseChain(raw: unknown): MergeChain | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const c = raw as Record<string, unknown>;
  const side = SIDES.find((s) => s === c.side);
  if (!side || typeof c.request_id !== "string" || typeof c.base_request_id !== "string") return null;
  return { side, requestId: c.request_id, baseRequestId: c.base_request_id, route: parseRoute(c.route), oneTrip: parseOneTrip(c.one_trip) };
}

/** The names asked about: "דנה וגל", "דנה ו2 נוספים". */
export function oneTripNames(oneTrip: Pick<ChainOneTrip, "names" | "unnamed">): string {
  const more = oneTrip.unnamed > 0 ? [tv("mergedRide.chainMore", { count: String(oneTrip.unnamed) })] : [];
  return joinNames([...oneTrip.names, ...more]);
}
