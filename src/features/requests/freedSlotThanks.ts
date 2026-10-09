import { toast } from "sonner";

import { tv } from "@/i18n/he";

import { fetchFreedOfferOutcome } from "./api";

/** Cosmetic, read-only: after a member cancels a ride, thank them if one specific person got the car. */
export interface RawFreedOfferOutcome {
  status: string;
  winning_request_id: string | null;
  winner: { requester: { full_name: string | null } | null } | null;
}

/** The winner's name when an offer was auto-assigned to one specific person, else null. */
export function winnerNameOf(rows: readonly RawFreedOfferOutcome[]): string | null {
  for (const row of rows) {
    if (row.status !== "auto_assigned" || !row.winning_request_id) continue;
    const name = row.winner?.requester?.full_name?.trim();
    if (name) return name;
  }
  return null;
}

/** True when the offers are settled one way or the other (stop polling). */
export function isDecisive(rows: readonly RawFreedOfferOutcome[]): boolean {
  return rows.length > 0 && rows.every((r) => r.status !== "open");
}

const FIRST_DELAY_MS = 1000;
const INTERVAL_MS = 2000;
const TOTAL_MS = 10000;

/** Polls (1s, then every 2s, up to ~10s) and toasts once. Never throws; returns a cancel function. */
export function pollFreedSlotThanks(
  rideId: string,
  fetchOutcome: (rideId: string) => Promise<RawFreedOfferOutcome[]> = fetchFreedOfferOutcome,
  notify: (name: string) => void = (name) => { toast.success(tv("request.freedSlotThanks", { name })); },
): () => void {
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let elapsed = 0;
  const tick = async (): Promise<void> => {
    timer = undefined;
    try {
      const rows = await fetchOutcome(rideId);
      if (stopped) return;
      const name = winnerNameOf(rows);
      if (name) { stopped = true; notify(name); return; }
      if (isDecisive(rows)) { stopped = true; return; }
    } catch {
      if (stopped) return;
    }
    elapsed += elapsed === 0 ? FIRST_DELAY_MS : INTERVAL_MS;
    if (elapsed + INTERVAL_MS > TOTAL_MS + FIRST_DELAY_MS) { stopped = true; return; }
    timer = setTimeout(() => { void tick(); }, INTERVAL_MS);
  };
  timer = setTimeout(() => { void tick(); }, FIRST_DELAY_MS);
  return () => { stopped = true; if (timer) clearTimeout(timer); };
}
