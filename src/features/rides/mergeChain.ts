// CM1 phase 2 (REQ item 260 b): the same person's two trips one after the other merge into one chained ride. The
// server (`_merge_check` -> `merge_preview` / `member_merge_preview`) decides and sends the chain; these read it.
/** CM1 phase 2: a chained merge - which trip rides first and the one ride's places in order. */
export interface MergeChain {
  side: "before" | "after";
  /** The chained (short) trip's request; the other one is the route base. */
  requestId: string;
  baseRequestId: string;
  route: { leg: "out" | "return"; placeId: string | null; name: string }[];
}

/** "נבו ← בית ספר ← חיפה ← נבו": the chained ride's places once each in order (the way back starts where the way there ends). */
export function chainRouteText(chain: MergeChain): string {
  const out = chain.route.filter((p) => p.leg === "out");
  const back = chain.route.filter((p) => p.leg === "return");
  return [...out, ...(out.length ? back.slice(1) : back)].map((p) => p.name).join(" ← ");
}

export function parseChain(raw: unknown): MergeChain | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const c = raw as Record<string, unknown>;
  if ((c.side !== "before" && c.side !== "after") || typeof c.request_id !== "string" || typeof c.base_request_id !== "string") return null;
  const route = Array.isArray(c.route) ? c.route.flatMap((p): MergeChain["route"] => {
    const row = p as Record<string, unknown>;
    return row.leg === "out" || row.leg === "return"
      ? [{ leg: row.leg, placeId: typeof row.place_id === "string" ? row.place_id : null, name: typeof row.name === "string" ? row.name : "" }] : [];
  }) : [];
  return { side: c.side, requestId: c.request_id, baseRequestId: c.base_request_id, route };
}
