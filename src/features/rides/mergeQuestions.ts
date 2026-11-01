// REQ §13.175: the questions a merge asks before it is made — "the detour is long, merge anyway?" and "take the guest
// at the ride's time, or stretch the ride to the guest's time?" — shared by the Sadran's board and the member's siddur.
import { tv } from "@/i18n/he";

/** REQ §13.175 (a): the added driving per leg of a long detour, and the hops whose travel time is not known. */
export interface LongDetour {
  outMinutes: number;
  returnMinutes: number;
  unknownHops: { from: string; to: string }[];
}

export function parseLongDetour(r: Record<string, unknown>): LongDetour | null {
  if (r.detour_waivable !== true) return null;
  const hops = Array.isArray(r.unknown_hops)
    ? r.unknown_hops.flatMap((hop) => {
      const row = hop as Record<string, unknown>;
      return typeof row.from === "string" && typeof row.to === "string" ? [{ from: row.from, to: row.to }] : [];
    })
    : [];
  return { outMinutes: Number(r.added_out_minutes) || 0, returnMinutes: Number(r.added_return_minutes) || 0, unknownHops: hops };
}

/** REQ §13.175 (a): "העיקוף ארוך (הנסיעה של X ל…, האיסוף של Y מ…): עוד N דק׳ נסיעה. לאחד בכל זאת?" plus the unknown hops. */
export function longDetourText(detour: LongDetour, names: { host: string; hostPlace: string; guest: string; guestPlace: string; leg: "out" | "return" | "both" }): string {
  const stop = tv(names.leg === "out" ? "mergedRide.longDetourDrop" : "mergedRide.longDetourPickup", { name: names.guest, place: names.guestPlace });
  const body = tv("mergedRide.longDetourBody", {
    ride: tv("mergedRide.longDetourRide", { name: names.host, place: names.hostPlace }),
    stop,
    minutes: String(Math.max(detour.outMinutes, detour.returnMinutes)),
  });
  return [body, ...detour.unknownHops.map((hop) => tv("mergedRide.longDetourUnknown", hop))].join(" ");
}

/**
 * REQ §13.175 (b): the merged ride reaches the guest at another time than asked, beyond the guest's flexibility, and the
 * host's ride can stretch to the guest's time - later on the way back (`endsAt`), earlier on the way out (`startsAt`).
 * `null` when the guest's time holds (or no window can).
 */
export interface MergeWaitChoice {
  side: "out" | "return";
  /** When the merged ride reaches the guest. */
  eta: string;
  /** The guest's own time. */
  wanted: string;
  startsAt: string | null;
  endsAt: string | null;
}

