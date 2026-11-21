import { he } from "@/i18n/he";

import { namesByLeg, rideCarriesBothLegs, type LegName, type RideLeg } from "./rideLegMark";

export interface RidePublicEntry {
  requester?: string | null;
  ride_description?: string | null;
  guest_passenger_names?: string[];
  companions?: { profile_id: string; name: string }[];
  /** Named children traveling on the request (`request_children` → `children.full_name`), distinct from guessed "unnamed child" counts. */
  childNames?: string[];
  /** `served[].leg`: a one-way rider's companions are marked (REQ §13.178) — by `ride_leg` when known (REQ §13.179 d). */
  leg?: RideLeg;
  ride_leg?: RideLeg;
}

/** One piece of a line; `emphasis` = a name to pick out (underlined, owner 2026-11-16). */
export interface RichSegment { text: string; emphasis?: boolean }
export type RichLine = readonly RichSegment[];

export interface RidePublicDetailOptions {
  includeCompanions?: boolean;
  /** Directly `add_ride_passengers()`-added names (`v_board_rides.people`, `source: 'added'`, REQ §13.85) - not tied to
   * any one served request; they join the one "נוסעים נוספים" line. */
  addedNames?: readonly (string | LegName)[];
}

/**
 * Only explicitly public request fields belong on the shared siddur. Owner 2026-11-16: each request's own words, led by
 * "<name>:" when the ride serves several (the name underlined), then ONE "נוסעים נוספים" line for the whole ride at the
 * bottom, every name underlined - not one per request, which people stop reading.
 */
export function ridePublicDetailLines(entries: readonly RidePublicEntry[], options: RidePublicDetailOptions = {}): RichLine[] {
  const bothLegs = rideCarriesBothLegs(entries.map((entry) => entry.ride_leg ?? entry.leg));
  const lines: RichLine[] = entries.flatMap((entry): RichLine[] => {
    const text = entry.ride_description?.trim();
    if (!text) return [];
    return [entries.length > 1 && entry.requester ? [{ text: `${entry.requester}:`, emphasis: true }, { text: ` ${text}` }] : [{ text }]];
  });
  if (options.includeCompanions === false) return lines;
  const names: LegName[] = [
    ...entries.flatMap((entry) => [
      ...(entry.companions ?? []).map((person) => person.name),
      ...(entry.guest_passenger_names ?? []),
      ...(entry.childNames ?? []),
    ].map((name) => name.trim()).filter(Boolean).map((name) => ({ name, leg: entry.ride_leg ?? entry.leg }))),
    ...(options.addedNames ?? []).map((added) => (typeof added === "string" ? { name: added, leg: undefined } : added))
      .map((item) => ({ ...item, name: item.name?.trim() ?? "" })).filter((item) => !!item.name),
  ];
  // RP1: someone rides one way only — "הלוך: …" / "חזור: …" instead of a mark on each name.
  const byLeg = namesByLeg(names, bothLegs);
  if (byLeg) {
    if (byLeg.out.length) lines.push(namesLine(he.ridePublicDetails.legOutLine, byLeg.out));
    if (byLeg.ret.length) lines.push(namesLine(he.ridePublicDetails.legReturnLine, byLeg.ret));
  } else if (names.length) lines.push(companionsLine(names.map((item) => item.name)));
  return lines;
}

/** "נוסעים נוספים: א, ב" with each name picked out. */
export function companionsLine(names: readonly string[]): RichLine {
  return namesLine(he.ridePublicDetails.companions, names);
}

/** A "{{names}}" template with each name picked out. */
function namesLine(template: string, names: readonly string[]): RichLine {
  const [before = "", after = ""] = template.split("{{names}}");
  return [
    ...(before ? [{ text: before }] : []),
    ...names.flatMap((name, i) => [...(i ? [{ text: ", " }] : []), { text: name, emphasis: true }]),
    ...(after ? [{ text: after }] : []),
  ];
}

export function richLinesText(lines: readonly RichLine[]): string {
  return lines.map((line) => line.map((segment) => segment.text).join("")).join("\n");
}

/** The same as plain text (titles, exports, tests). */
export function ridePublicDetails(entries: readonly RidePublicEntry[], options: RidePublicDetailOptions = {}): string {
  return richLinesText(ridePublicDetailLines(entries, options));
}

/** A ride's notes (its own, then each request's words, then the one "נוסעים נוספים" line); undefined when empty. */
export function rideDescriptionLines(rideNotes: string | null | undefined, entries: readonly RidePublicEntry[], options: RidePublicDetailOptions = {}): RichLine[] | undefined {
  const own = rideNotes?.trim();
  const lines = [...(own ? [[{ text: own }]] : []), ...ridePublicDetailLines(entries, options)];
  return lines.length ? lines : undefined;
}

/** `description` (plain) and `descriptionLines` (names picked out) together, for grid blocks and cards. */
export function rideDescriptionFields(rideNotes: string | null | undefined, entries: readonly RidePublicEntry[], options: RidePublicDetailOptions = {}): { description?: string; descriptionLines?: RichLine[] } {
  const lines = rideDescriptionLines(rideNotes, entries, options);
  return lines ? { description: richLinesText(lines), descriptionLines: lines } : {};
}
