// The canonical placeholder tokens (docs/UX_FLOWS.md §6, top of section: the
// full `{{...}}` legend shared by every event/WhatsApp template). Plain
// English identifiers, not Hebrew UI copy, so they live alongside the
// feature code rather than in `src/i18n/he.ts` (CLAUDE.md hard rule 3 is
// about Hebrew *strings*, not these token names).
export const NOTIFICATION_PLACEHOLDERS = [
  "firstName",
  "sadranName",
  "dept",
  "weekLabel",
  "day",
  "date",
  "destination",
  "depart",
  "return",
  "newDepart",
  "newReturn",
  "car",
  "driverName",
  "passengerName",
  "detourMin",
  "reason",
  "closeTime",
  "count",
  "link",
] as const;

export type NotificationPlaceholder = (typeof NOTIFICATION_PLACEHOLDERS)[number];

/**
 * Sample Hebrew values for the live preview (UX_FLOWS §5.9 "preview with
 * sample data") — fake demo data standing in for what a real notification
 * would substitute, not translatable UI copy, so left outside `he.ts`
 * (docs/REFACTOR_BACKLOG.md §5.4 grep sweep).
 */
export const PLACEHOLDER_SAMPLES: Record<NotificationPlaceholder, string> = {
  firstName: "דנה",
  sadranName: "מיכל",
  dept: "כללי",
  weekLabel: "14–20.9",
  day: "יום ג'",
  date: "16.9",
  destination: "עפולה",
  depart: "08:30",
  return: "13:00",
  newDepart: "09:00",
  newReturn: "13:30",
  car: "יונדאי 3",
  driverName: "רון",
  passengerName: "נועה",
  detourMin: "10",
  reason: "אין רכב פנוי בשעות אלה",
  closeTime: "יום ד׳ 12:00",
  count: "2",
  link: "https://nevo.example/p/xxxx",
};

/** Fills `{{placeholder}}` tokens with sample values for a live preview; unknown tokens pass through. */
export function renderSample(text: string): string {
  return text.replace(/\{\{(\w+)\}\}/g, (match, name: string) =>
    name in PLACEHOLDER_SAMPLES ? PLACEHOLDER_SAMPLES[name as NotificationPlaceholder] : match,
  );
}
