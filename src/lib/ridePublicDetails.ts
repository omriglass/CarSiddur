import { he } from "@/i18n/he";

import { ridePassengerParts, unnamedParts } from "./ridePassengerSummary";
import type { LegName, RideLeg } from "./rideLegMark";

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
  /** For the people line's unnamed seats and to leave out the driver (served entries carry them). */
  request_id?: string | null;
  role?: "driver" | "passenger";
  adults?: number;
  child_seats?: number;
  boosters?: number;
}

/** One piece of a line; `emphasis` = a name to pick out (underlined, owner 2026-11-16). */
export interface RichSegment { text: string; emphasis?: boolean }
export type RichLine = readonly RichSegment[];

export interface RidePublicDetailOptions {
  includeCompanions?: boolean;
  /** Directly `add_ride_passengers()`-added names (`v_board_rides.people`, `source: 'added'`, REQ §13.85) - not tied to
   * any one served request; they join the one "נוסעים נוספים" line. */
  addedNames?: readonly (string | LegName)[];
  /** The ride's driver, listed first when no served request is theirs (a volunteer); null when it needs one. */
  driverName?: string | null;
}

/**
 * Only explicitly public request fields belong on the shared siddur. Owner 2026-11-16: each request's own words, led by
 * "<name>:" when the ride serves several (the name underlined), then ONE people line for the whole ride at the bottom,
 * every name underlined. RP1 (owner 2026-11-21): that line is the ride's only people list, the same for everyone -
 * "נוסעים: …" with everyone on the ride - the driver too (owner: the driver is a rider like the others), other requests'
 * riders, companions, children, guests, people added with "+ נוסע/ת", unnamed seats, or "הלוך: …" / "חזור: …" when someone rides one way.
 */
export function ridePublicDetailLines(entries: readonly RidePublicEntry[], options: RidePublicDetailOptions = {}): RichLine[] {
  const lines: RichLine[] = entries.flatMap((entry): RichLine[] => {
    const text = entry.ride_description?.trim();
    if (!text) return [];
    return [entries.length > 1 && entry.requester ? [{ text: `${entry.requester}:`, emphasis: true }, { text: ` ${text}` }] : [{ text }]];
  });
  if (options.includeCompanions === false) return lines;
  const parts = ridePassengerParts(
    entries.map((entry) => ({ ...entry, adults: entry.adults ?? 0, child_seats: entry.child_seats ?? 0, boosters: entry.boosters ?? 0 })),
    options.driverName ?? null, { addedNames: options.addedNames },
  );
  if (parts.byLeg) {
    const { out, ret } = parts.byLeg;
    if (out.names.length || out.adults || out.children) lines.push(namesLine(he.ridePublicDetails.legOutLine, out.names, unnamedParts(out.adults, out.children)));
    if (ret.names.length || ret.adults || ret.children) lines.push(namesLine(he.ridePublicDetails.legReturnLine, ret.names, unnamedParts(ret.adults, ret.children)));
  } else if (parts.names.length || parts.adults || parts.children) {
    lines.push(namesLine(he.ridePublicDetails.peopleLine, parts.names, unnamedParts(parts.adults, parts.children)));
  }
  return lines;
}

/** A "{{names}}" template with each name picked out (unnamed seats after them, plain). */
function namesLine(template: string, names: readonly string[], plain: readonly string[] = []): RichLine {
  const [before = "", after = ""] = template.split("{{names}}");
  const items = [...names.map((text) => ({ text, emphasis: true })), ...plain.map((text) => ({ text }))];
  return [
    ...(before ? [{ text: before }] : []),
    ...items.flatMap((item, i) => [...(i ? [{ text: ", " }] : []), item]),
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
