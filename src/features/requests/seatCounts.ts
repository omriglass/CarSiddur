/**
 * The `adults` / `child_seats` the request form sends to `submit_request`, given the seat
 * contract of `set_request_children()` (`20260908155000_child_birth_year_and_seat_counts.sql`):
 * that RPC treats the request row's counts as *including the children currently linked to
 * the request*, subtracts those, then adds the newly selected children back (re-classified
 * by birth year, eight and above = an adult seat).
 *
 * The form calls the two RPCs back to back — `submit_request` writes the counts, then
 * `set_request_children` replaces the child set. So the counts the form writes must include
 * exactly the children the server knows *before* the second call (the request's previous
 * child set — none for a new request), never the newly selected ones: sending the selected
 * children's seats here made the RPC add them a second time, so every request filed with one
 * named child under eight ended up with `child_seats = 2` and the ride details read
 * "X, Y וילד/ה 1" (owner bug report 2026-09-14). Re-saving a request through the form heals a
 * doubled row, because the previous children are then subtracted by the RPC as designed.
 */
export interface SeatCountChild {
  /** `fetchChildren(...).isAdultPassenger` — eight or older in the ride's calendar year. */
  isAdultPassenger: boolean;
}

export interface PayloadSeatCountsInput {
  companionsCount: number;
  guestsCount: number;
  /** Unnamed child seats the member typed in (`RequestFormValues.legacyChildSeats`). */
  legacyChildSeats: number;
  /** Children linked to the request on the server right now (empty for a new request). */
  previousChildren: readonly SeatCountChild[];
}

export function payloadSeatCounts(input: PayloadSeatCountsInput): { adults: number; childSeats: number } {
  const previousAdultChildren = input.previousChildren.filter((child) => child.isAdultPassenger).length;
  const previousChildSeatChildren = input.previousChildren.length - previousAdultChildren;
  return {
    adults: 1 + input.companionsCount + input.guestsCount + previousAdultChildren,
    childSeats: Math.max(0, input.legacyChildSeats) + previousChildSeatChildren,
  };
}

/**
 * What the row holds once `set_request_children()` has run on top of `payloadSeatCounts`'s
 * write — the RPC's arithmetic, kept here so the unit test can prove the round trip and
 * nobody has to re-derive it from SQL. Mirrors the function body exactly.
 */
export function serverSeatCountsAfterChildren(
  written: { adults: number; childSeats: number },
  previousChildren: readonly SeatCountChild[],
  selectedChildren: readonly SeatCountChild[],
): { adults: number; childSeats: number } {
  const count = (list: readonly SeatCountChild[]) => ({
    adult: list.filter((child) => child.isAdultPassenger).length,
    seat: list.filter((child) => !child.isAdultPassenger).length,
  });
  const previous = count(previousChildren);
  const selected = count(selectedChildren);
  return {
    adults: Math.max(1, written.adults - previous.adult) + selected.adult,
    childSeats: Math.max(0, written.childSeats - previous.seat) + selected.seat,
  };
}
