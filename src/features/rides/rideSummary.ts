// The ride sheet's summary sentence. RP1 (owner 2026-11-21): each way as a flow anyone can follow - who leaves from
// where, who is left / picked up at each place on the way, where the car goes on to:
//   "חבר, טל וגל יוצאים מהבית, משאירים את גל בזכרון יעקב וממשיכים לבנימינה. בחזור: חבר וטל יוצאים מבנימינה, אוספים את
//    גל מזכרון יעקב וממשיכים הביתה."
// A simple ride (everyone the whole way, the same people both ways, nothing in the middle) keeps the ride's own label
// ("חבר לבנימינה"). Built from the stops view's rows (`stopRows`), so the two never disagree.
import { he, tv } from "@/i18n/he";

import type { StopRow } from "./rideStretches";

/** "נועה", "נועה ועידו", "נועה, עידו ודנה". */
export function namesList(names: readonly string[]): string {
  if (names.length <= 1) return names[0] ?? "";
  return tv("rideSummary.listAnd", { init: names.slice(0, -1).join(", "), last: names[names.length - 1]! });
}

/** First names, unless two people share one. */
function shortNames(rows: readonly StopRow[]): (name: string) => string {
  const all = new Set(rows.flatMap((row) => [...row.on, ...row.off]));
  const first = (name: string) => name.split(/\s+/)[0] ?? name;
  const count = new Map<string, number>();
  for (const name of all) count.set(first(name), (count.get(first(name)) ?? 0) + 1);
  return (name) => (count.get(first(name)) === 1 ? first(name) : name);
}

/** One way as a flow: who leaves from where, what happens at each place on the way, where they go on to. */
function legText(rows: readonly StopRow[], homeId: string | null, short: (name: string) => string): string {
  const list = (names: readonly string[]) => namesList(names.map(short));
  const placeName = (row: StopRow) => (homeId && row.point.placeId === homeId ? null : row.point.name);
  const start = rows[0]!;
  const end = rows[rows.length - 1]!;
  let inCar = start.on.length;
  const one = (key: string) => (inCar === 1 ? `${key}One` : key) as Parameters<typeof tv>[0];
  const from = placeName(start) ?? he.rideSummary.homeWord;
  const head = tv(one("rideSummary.leave"), { names: list(start.on), from });
  const endName = placeName(end);
  const to = endName ? tv("rideSummary.to", { place: endName }) : he.rideSummary.toHome;
  const middle = rows.slice(1, -1);
  if (!middle.length) return `${head} ${to}`;
  const steps = middle.map((row) => {
    const place = row.point.name;
    const text = row.off.length && row.on.length ? tv(one("rideSummary.dropPick"), { off: list(row.off), on: list(row.on), place })
      : row.off.length ? tv(one("rideSummary.drop"), { names: list(row.off), place })
      : row.on.length ? tv(one("rideSummary.pick"), { names: list(row.on), place })
      : tv(one("rideSummary.pass"), { place });
    inCar += row.on.length - row.off.length;
    return text;
  });
  return `${head}, ${steps.join(", ")} ${tv(one("rideSummary.goOn"), { to })}`;
}

/** Nothing to explain: no places in the middle and everyone rides each way whole, the same people both ways. */
function plain(out: readonly StopRow[], back: readonly StopRow[]): boolean {
  const whole = (rows: readonly StopRow[]) => rows.length === 2 && rows[0]!.on.join("|") === rows[1]!.off.join("|");
  if (out.length && !whole(out)) return false;
  if (back.length && !whole(back)) return false;
  return !out.length || !back.length || [...out[0]!.on].sort().join("|") === [...back[0]!.on].sort().join("|");
}

/**
 * The sentence; `lead` (the ride's label) when there is nothing more to say. `oneWay`: the ride goes that way only
 * (its route has no other leg) - said clearly, "· הלוך בלבד" / "· חזור בלבד" (owner 2026-11-21).
 */
export function rideSummaryText(lead: string, rows: readonly StopRow[], homeId: string | null = null, oneWay: "out" | "return" | null = null): string {
  const mark = (text: string) => (oneWay ? tv(oneWay === "out" ? "rideSummary.onlyOut" : "rideSummary.onlyBack", { text }) : text);
  const out = rows.filter((row) => row.leg === "out");
  const back = rows.filter((row) => row.leg === "return");
  if (!rows.length || plain(out, back)) return mark(lead);
  const short = shortNames(rows);
  if (!out.length || !back.length) return `${mark(legText(out.length ? out : back, homeId, short))}.`;
  return `${legText(out, homeId, short)}. ${tv("rideSummary.back", { text: legText(back, homeId, short) })}.`;
}
