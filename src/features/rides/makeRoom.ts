// REQ §13.203 (b): what each driver in the way could give up — the pure part of the "make room" dialog.
import type { TranslationKey } from "@/i18n/he";
import { formatDayDate } from "@/lib/dayLabels";
import { formatTime } from "@/lib/time";

import type { MakeRoomCut, MakeRoomParty, RideChange } from "./api";

export interface MakeRoomChoice {
  cut: MakeRoomCut;
  /** Minutes the driver gives up (the whole ride for "cancel"). */
  minutes: number;
  /** The ride's new end ("end") or start ("start"); null for "cancel". */
  at: string | null;
}

const minutesBetween = (from: string, to: string) => Math.round((Date.parse(to) - Date.parse(from)) / 60_000);

/** Every way this driver can make room, smallest first (giving the ride up is always last). */
export function makeRoomChoices(party: MakeRoomParty): MakeRoomChoice[] {
  const shorter: MakeRoomChoice[] = [];
  if (party.end_option) shorter.push({ cut: "end", minutes: minutesBetween(party.end_option, party.ends_at), at: party.end_option });
  if (party.start_option) shorter.push({ cut: "start", minutes: minutesBetween(party.starts_at, party.start_option), at: party.start_option });
  shorter.sort((a, b) => a.minutes - b.minutes || a.cut.localeCompare(b.cut));
  return [...shorter, { cut: "cancel", minutes: minutesBetween(party.starts_at, party.ends_at), at: null }];
}

/** The pre-selected answer per ride: the smallest change. */
export function defaultCuts(parties: readonly MakeRoomParty[]): Record<string, MakeRoomCut> {
  return Object.fromEntries(parties.map((party) => [party.ride_id, makeRoomChoices(party)[0]?.cut ?? "cancel"]));
}

/** Distinct driver names in the order shown ("נגה, דן"). */
export function makeRoomNames(parties: readonly MakeRoomParty[]): string {
  return [...new Set(parties.map((party) => party.name).filter(Boolean))].join(", ");
}

type Party = RideChange["parties"][number];
/** The asked driver's ride as it is now (for "instead of …"). */
export interface AskedRide { starts_at: string | null; ends_at: string | null }

/** The copy keys and vars for what this party is asked (REQ §13.203 c). */
export function askedOf(party: Party | undefined, ride: AskedRide | undefined): { body: TranslationKey; accept: TranslationKey; vars: Record<string, string> } {
  const at = (iso: string | null | undefined) => (iso ? formatTime(new Date(iso)) : "");
  const minutes = (from: string | null | undefined, to: string | null | undefined) =>
    from && to ? String(Math.round((Date.parse(to) - Date.parse(from)) / 60_000)) : "";
  const mine = ride?.starts_at && ride.ends_at ? `${formatDayDate(ride.starts_at)} \u2066${at(ride.starts_at)}–${at(ride.ends_at)}\u2069` : "";
  const day = ride?.starts_at ? formatDayDate(ride.starts_at) : "";
  if (party?.cut === "end" && party.new_ends_at) {
    return { body: "rideEditing.answerEndBody", accept: "rideEditing.acceptEnd",
      vars: { mine, day, newTime: at(party.new_ends_at), oldTime: at(ride?.ends_at), minutes: minutes(party.new_ends_at, ride?.ends_at) } };
  }
  if (party?.cut === "start" && party.new_starts_at) {
    return { body: "rideEditing.answerStartBody", accept: "rideEditing.acceptStart",
      vars: { mine, day, newTime: at(party.new_starts_at), oldTime: at(ride?.starts_at), minutes: minutes(ride?.starts_at, party.new_starts_at) } };
  }
  return { body: "rideEditing.answerBody", accept: "rideEditing.accept", vars: { mine, day } };
}
