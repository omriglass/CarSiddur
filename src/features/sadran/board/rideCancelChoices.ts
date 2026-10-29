// REQ §13.162 (a): the board's "בטל נסיעה" asks, per request on the ride, whether it is still needed.
// Pure: no React, Supabase or i18n.
import type { ServedEntry } from "@/features/rides/servedOf";

/** `keep` = back on the waiting list (the default); `close` = the ride is no longer relevant, the request is closed. */
export type RideCancelChoice = "keep" | "close";

export interface RideCancelLine {
  requestId: string;
  /** The requester's name (`v_board_rides.served[].requester`); empty when the view has none. */
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

export function choiceOf(choices: Readonly<Record<string, RideCancelChoice>>, requestId: string): RideCancelChoice {
  return choices[requestId] ?? "keep";
}

/** The requests the Sadran chose to close, in line order (what `sadran_cancel_ride` takes). */
export function closeRequestIds(lines: readonly RideCancelLine[], choices: Readonly<Record<string, RideCancelChoice>>): string[] {
  return lines.filter((line) => choiceOf(choices, line.requestId) === "close").map((line) => line.requestId);
}
