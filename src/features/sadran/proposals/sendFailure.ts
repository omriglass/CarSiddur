/**
 * R14B6: a proposal created and sent in one click that the server then refuses at send time (car busy, seats, trial
 * apply, ...) must not leave a stray draft behind. Only the draft this very click created is discarded - never one
 * the Sadran opened - and only on a real refusal from the database: a network failure, a gateway/5xx error or a
 * transient database state (connection, serialization, resources) keeps it, so "retry the send" still works.
 */
const TRANSIENT_SQLSTATE_CLASSES = new Set(["08", "40", "53", "57", "58"]);

export function shouldDiscardAfterFailedSend(error: unknown, createdNow: boolean): boolean {
  if (!createdNow) return false;
  const code = (error as { code?: unknown } | null | undefined)?.code;
  if (typeof code !== "string" || !/^[0-9A-Z]{5}$/.test(code)) return false;
  return !TRANSIENT_SQLSTATE_CLASSES.has(code.slice(0, 2));
}
