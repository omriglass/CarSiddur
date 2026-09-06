// src/features/sadran/proposals/waLink.ts
//
// Renders a WhatsApp proposal template (`notification_templates` rows,
// `channel = 'whatsapp'`, UX_FLOWS.md §6.2) with concrete placeholder values,
// and builds the `https://wa.me/<E.164 digits, no '+'>?text=<encoded>` URL
// the Sadran taps to send it (REQUIREMENTS §7.3). Pure string handling, no
// Supabase/React — the composer screen supplies the template text (already
// fetched from the DB) and the recipient's `profiles.phone` (stored E.164,
// `src/features/auth/schema.ts`).

const PLACEHOLDER_RE = /\{\{(\w+)\}\}/g;

/** Fills `{{name}}` placeholders from `vars`; a token with no matching var is left as-is (never silently dropped). */
export function renderTemplate(text: string, vars: Record<string, string>): string {
  return text.replace(PLACEHOLDER_RE, (match: string, name: string) => vars[name] ?? match);
}

/** Strips everything but digits from an E.164 phone (`+972501234567` -> `972501234567`) for the `wa.me` path segment. */
export function toWaDigits(phoneE164: string): string {
  return phoneE164.replace(/\D/g, "");
}

/** Builds the `wa.me` deep link the Sadran opens in a new tab to send `text` to `phoneE164`. */
export function buildWaUrl(phoneE164: string, text: string): string {
  const digits = toWaDigits(phoneE164);
  return `https://wa.me/${digits}?text=${encodeURIComponent(text)}`;
}
