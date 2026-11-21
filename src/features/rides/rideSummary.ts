// The ride sheet's summary sentence. RP1 (owner 2026-11-21): one self-contained sentence per direction that says who
// rides from where to where - everyone on the ride, grouped by where they get on and off:
//   "חבר וענבר לבנימינה דרך זכרון יעקב. בחזור: חבר ונגה מבנימינה הביתה."
//   "חבר ודנה לבנימינה דרך זכרון יעקב; נועה ועידו לזכרון יעקב. בחזור: …"
// The way there leaves out "from home"; the way back says where it starts; home is "הביתה". A ride where everyone rides
// the whole way both ways and nothing is in the middle keeps the ride's own label (`rideBlockLabel`). Built from the
// stops view's rows (`stopRows`), so the two never disagree.
import { tv } from "@/i18n/he";

import type { StopRow } from "./rideStretches";

/** "נועה", "נועה ועידו", "נועה, עידו ודנה". */
export function namesList(names: readonly string[]): string {
  if (names.length <= 1) return names[0] ?? "";
  return tv("rideSummary.listAnd", { init: names.slice(0, -1).join(", "), last: names[names.length - 1]! });
}

interface Group { from: number; to: number; names: string[] }

/** Everyone's [get on, get off] on one leg, grouped; the longest part first (the driver's), then by where they get on. */
function legGroups(rows: readonly StopRow[]): Group[] {
  const spans = new Map<string, [number, number]>();
  rows.forEach((row, i) => {
    for (const name of row.on) spans.set(name, [i, spans.get(name)?.[1] ?? rows.length - 1]);
    for (const name of row.off) spans.set(name, [spans.get(name)?.[0] ?? 0, i]);
  });
  const groups: Group[] = [];
  for (const [name, [from, to]] of spans) {
    const group = groups.find((g) => g.from === from && g.to === to);
    if (group) group.names.push(name);
    else groups.push({ from, to, names: [name] });
  }
  return groups.sort((a, b) => a.from - b.from || b.to - a.to);
}

/** First names, unless two people share one. */
function shortNames(rows: readonly StopRow[]): (name: string) => string {
  const all = new Set(rows.flatMap((row) => [...row.on, ...row.off]));
  const first = (name: string) => name.split(/\s+/)[0] ?? name;
  const count = new Map<string, number>();
  for (const name of all) count.set(first(name), (count.get(first(name)) ?? 0) + 1);
  return (name) => (count.get(first(name)) === 1 ? first(name) : name);
}

function legText(rows: readonly StopRow[], homeId: string | null, short: (name: string) => string): string {
  return legGroups(rows).map((group) => {
    const from = rows[group.from]!.point;
    const to = rows[group.to]!.point;
    const names = namesList(group.names.map(short));
    const showFrom = group.from > 0 || (homeId ? from.placeId !== homeId : rows[0]!.leg === "return");
    const toHome = !!homeId && to.placeId === homeId;
    const where = showFrom
      ? toHome ? tv("rideSummary.fromHome", { names, from: from.name }) : tv("rideSummary.fromTo", { names, from: from.name, to: to.name })
      : toHome ? tv("rideSummary.home", { names }) : tv("rideSummary.to", { names, to: to.name });
    const via = [...new Set(rows.slice(group.from + 1, group.to).map((row) => row.point.name))];
    return via.length ? tv("rideSummary.via", { text: where, places: via.join(", ") }) : where;
  }).join("; ");
}

/** Nothing to explain: no places in the middle and everyone rides each way whole, the same people both ways. */
function plain(out: readonly StopRow[], back: readonly StopRow[]): boolean {
  const whole = (rows: readonly StopRow[]) => rows.length === 2 && rows[0]!.on.join("|") === rows[1]!.off.join("|");
  if (out.length && !whole(out)) return false;
  if (back.length && !whole(back)) return false;
  return !out.length || !back.length || [...out[0]!.on].sort().join("|") === [...back[0]!.on].sort().join("|");
}

/** The sentence; `lead` (the ride's label) when there is nothing more to say. */
export function rideSummaryText(lead: string, rows: readonly StopRow[], homeId: string | null = null): string {
  const out = rows.filter((row) => row.leg === "out");
  const back = rows.filter((row) => row.leg === "return");
  if (!rows.length || plain(out, back)) return lead;
  const short = shortNames(rows);
  const parts = [
    out.length ? `${legText(out, homeId, short)}.` : "",
    back.length ? `${out.length ? tv("rideSummary.back", { text: legText(back, homeId, short) }) : legText(back, homeId, short)}.` : "",
  ];
  return parts.filter(Boolean).join(" ");
}
