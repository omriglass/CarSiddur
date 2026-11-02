// REQ §13.179 (b, owner 2026-11-02): a member moving a ride that others ride on changes their own part of it - the move
// asks "דיברת עם X על השינוי?" first. `edit_ride` refuses with `ride_move_needs_agreement` (detail = the names) unless
// called again with `agreed: true`; `editRide` runs through `withRideAgreementRetry`, which asks on the one
// `RideMoveAgreementHost` dialog (mounted in main.tsx) and retries on a yes - the same shape as `lib/personBusy.ts`.
import { AppError } from "./rpc";

export function isRideMoveNeedsAgreement(error: unknown): error is AppError {
  return error instanceof AppError && error.code === "ride_move_needs_agreement";
}

export type RideAgreementAsker = (names: string) => Promise<boolean>;
let hostAsker: RideAgreementAsker | null = null;

/** `RideMoveAgreementHost` registers the dialog here (and clears it on unmount). */
export function registerRideAgreementAsker(asker: RideAgreementAsker | null): void {
  hostAsker = asker;
}

/** Shows the shared question; `false` when no host is mounted (never go ahead without an explicit yes). */
export function askRideAgreement(names: string): Promise<boolean> {
  return hostAsker ? hostAsker(names) : Promise.resolve(false);
}

/**
 * `call(false)`, and on `ride_move_needs_agreement` the shared question, then `call(true)`. A "no" rejects with the
 * original refusal marked `declined`, so `showErrorToast` stays silent.
 */
export async function withRideAgreementRetry<T>(call: (agreed: boolean) => Promise<T>, ask: RideAgreementAsker = askRideAgreement): Promise<T> {
  try {
    return await call(false);
  } catch (error) {
    if (!isRideMoveNeedsAgreement(error)) throw error;
    if (!(await ask(error.detail ?? ""))) {
      error.declined = true;
      throw error;
    }
    return call(true);
  }
}
