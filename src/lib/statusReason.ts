import { he, type StatusReasonCode } from "@/i18n/he";

/**
 * Renders a `requests.status_reason` / audit `reason` value as Hebrew.
 * Falls back to `he.statusReasonUnknown` — never the raw UPPER_SNAKE code —
 * for anything not in `he.statusReason` (CLAUDE.md hard rule 3).
 */
export function describeStatusReason(code: string | null | undefined): string | null {
  if (!code) return null;
  if (code in he.statusReason) return he.statusReason[code as StatusReasonCode];
  return he.statusReasonUnknown;
}

/** Like `describeStatusReason` but `null` for a code the dictionary does not know — the generic "no details" placeholder adds nothing on a request card. */
export function knownStatusReason(code: string | null | undefined): string | null {
  return code && code in he.statusReason ? he.statusReason[code as StatusReasonCode] : null;
}
