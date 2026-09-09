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
