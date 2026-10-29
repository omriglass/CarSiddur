// REQ §13.162 (a): the board's "בטל נסיעה" asks, per request on the ride, whether it is still needed.
// O29-2 (3): on a ride that carries separate requests (a merge) each request may also continue on the ride.
// Pure: no React, Supabase or i18n.
import type { ServedEntry } from "@/features/rides/servedOf";

/**
 * `keep` = back on the waiting list; `close` = the ride is no longer relevant, the request is closed;
 * `continue` = "ממשיך/ה בנסיעה": the ride stays for it (offered only when the ride carries more than one request).
 */
export type RideCancelChoice = "keep" | "close" | "continue";

export interface RideCancelLine {
  requestId: string;
  /** The requester's name (`v_board_rides.served[].requester`); empty when the view has none. Companions and
   *  children are part of the request, so they are this one line. */
  name: string;
}

/** One line per request on the ride (a request on two legs of the ride is one line), the driver's first. */
export function rideCancelLines(served: readonly ServedEntry[]): RideCancelLine[] {
  const ordered = [...served].sort((a, b) => Number(b.role === "driver") - Number(a.role === "driver"));
  const lines: RideCancelLine[] = [];
  for (const entry of ordered) {
    if (!entry.request_id || lines.some((line) => line.requestId === entry.request_id)) continue;
    lines.push({ requestId: entry.request_id, name: entry.requester?.trim() ?? "" });
  }
  return lines;
}

/** Whether a line may continue on the ride: only when the ride carries separate requests. */
export function canContinue(lines: readonly RideCancelLine[]): boolean {
  return lines.length > 1;
}

/**
 * The line's choice; unset, the first line (the ride's own request - the one being cancelled) goes back to the waiting
 * list and, on a merged ride, every other request continues on it (owner 2026-10-29).
 */
export function choiceOf(choices: Readonly<Record<string, RideCancelChoice>>, requestId: string, lines: readonly RideCancelLine[] = []): RideCancelChoice {
  const chosen = choices[requestId];
  if (chosen && (chosen !== "continue" || canContinue(lines))) return chosen;
  return canContinue(lines) && lines[0]?.requestId !== requestId ? "continue" : "keep";
}

function idsWith(lines: readonly RideCancelLine[], choices: Readonly<Record<string, RideCancelChoice>>, choice: RideCancelChoice): string[] {
  return lines.filter((line) => choiceOf(choices, line.requestId, lines) === choice).map((line) => line.requestId);
}

/** The requests the Sadran chose to close, in line order (what `sadran_cancel_ride` takes). */
export function closeRequestIds(lines: readonly RideCancelLine[], choices: Readonly<Record<string, RideCancelChoice>>): string[] {
  return idsWith(lines, choices, "close");
}

/** The requests that continue on the ride (`p_continue_request_ids`); non-empty = the ride is kept for them. */
export function continueRequestIds(lines: readonly RideCancelLine[], choices: Readonly<Record<string, RideCancelChoice>>): string[] {
  return idsWith(lines, choices, "continue");
}

/** Every line continuing leaves nothing to cancel. */
export function nothingLeaves(lines: readonly RideCancelLine[], choices: Readonly<Record<string, RideCancelChoice>>): boolean {
  return lines.length > 0 && continueRequestIds(lines, choices).length === lines.length;
}
