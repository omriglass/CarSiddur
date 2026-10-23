import { toAppError } from "@/lib/rpc";

/**
 * R14B6: a proposal created and sent in one click that the server then refuses at send time (car busy, seats, trial
 * apply, ...) must not leave a stray draft behind. Only the draft this very click created is discarded - never one
 * the Sadran opened - and a network failure keeps it (the send may have reached the server).
 */
export function shouldDiscardAfterFailedSend(error: unknown, createdNow: boolean): boolean {
  if (!createdNow) return false;
  return toAppError(error).code !== "network";
}
