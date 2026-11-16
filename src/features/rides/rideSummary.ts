// REQ item 246 h (owner 2026-11-16): the ride sheet's summary in one or two sentences - who rides where, then the places
// in the middle in words: "חבר וסדרן לבנימינה, עוברים בזכרון יעקב להוריד את נועה ועידו ולאסוף את דנה. בחזור עוברים
// בזכרון יעקב לאסוף את נועה ועידו." Built from the stops view's rows (`stopRows`), so the two never disagree.
import { tv } from "@/i18n/he";

import type { StopRow } from "./rideStretches";

/** "נועה", "נועה ועידו", "נועה, עידו ודנה". */
export function namesList(names: readonly string[]): string {
  if (names.length <= 1) return names[0] ?? "";
  return tv("rideSummary.listAnd", { init: names.slice(0, -1).join(", "), last: names[names.length - 1]! });
}

/** One place in the middle: "עוברים בזכרון יעקב להוריד את נועה ולאסוף את דנה". */
function viaPhrase(row: StopRow): string {
  const place = row.point.name;
  const off = namesList(row.off);
  const on = namesList(row.on);
  const what = off && on ? tv("rideSummary.dropAndPick", { off, on })
    : off ? tv("rideSummary.drop", { names: off })
    : on ? tv("rideSummary.pick", { names: on })
    : "";
  return [tv("rideSummary.via", { place }), what].filter(Boolean).join(" ");
}

/** The sentence: the ride's own label (`rideBlockLabel`), then the places in the middle of each way. */
export function rideSummaryText(lead: string, rows: readonly StopRow[]): string {
  const middle = (leg: StopRow["leg"]) => {
    const legRows = rows.filter((row) => row.leg === leg);
    return legRows.slice(1, -1).map(viaPhrase).join(", ");
  };
  const out = middle("out");
  const back = middle("return");
  const first = out ? `${lead}, ${out}.` : back ? `${lead}.` : lead;
  return back ? `${first} ${tv("rideSummary.back", { text: back })}.` : first;
}
