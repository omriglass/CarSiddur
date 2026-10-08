// REQ §13.111 (a): a large-luggage request needs a car with a large trunk unless whoever placed it by hand
// waived that (`requests.luggage_waived_at`). The TS twin of SQL `request_needs_large_trunk()`; pure, so the
// solver bridge, the board's drop checks and the request cards all read the same rule.

export interface LuggageFields {
  has_luggage?: boolean | null;
  luggage_waived_at?: string | null;
}

/** Does this request still need a car with a large trunk (large luggage and not waived)? */
export function needsLargeTrunk(request: LuggageFields): boolean {
  return !!request.has_luggage && !request.luggage_waived_at;
}

/** Large luggage whose large-trunk requirement was waived by hand (the card shows `he.smallTrunk.waivedLabel`). */
export function isLuggageWaived(request: LuggageFields): boolean {
  return !!request.has_luggage && !!request.luggage_waived_at;
}

/**
 * A ride block's luggage marker from its served entries (`v_board_rides.served[]`): `needs` when some large
 * luggage still needs a large trunk, `waived` when all of it was waived by hand, else `none`.
 */
export function luggageMarker(entries: readonly { luggage?: boolean | null; luggage_waived?: boolean | null }[]): "none" | "needs" | "waived" {
  const withLuggage = entries.filter((entry) => entry.luggage);
  if (withLuggage.length === 0) return "none";
  return withLuggage.every((entry) => entry.luggage_waived) ? "waived" : "needs";
}
