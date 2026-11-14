// R20M1 (owner 2026-11-14, REQ item 233): the board strip "since you last looked" — one line per event others caused
// on a published day, newest first. Opening the strip counts as looked (the badge resets); the lines that were new
// stay highlighted for the rest of the visit.
import { joinFreedNames } from "@/features/rides/freedCarPreview";
import { tv } from "@/i18n/he";
import { formatDayDate } from "@/lib/dayLabels";
import { formatTime } from "@/lib/time";

import type { BoardLiveEvent } from "../api";

/** What happened, in the owner's words. */
export function liveEventText(event: BoardLiveEvent): string {
  const name = event.person_name ?? "";
  switch (event.kind) {
    case "driver_left":
      return tv("liveEvents.driverLeft", { name });
    case "driver_handed":
      return tv("liveEvents.driverHanded", { name, other: event.other_name ?? "" });
    case "cancelled":
      return tv("liveEvents.cancelled", { name });
    case "freed_placed":
      return tv("liveEvents.freedPlaced", { name });
    case "proposal_expired":
      return tv("liveEvents.proposalExpired", { name });
    case "joined": {
      const list = [...new Set((event.names ?? []).filter(Boolean))];
      const names = joinFreedNames(list, "and");
      const many = list.length > 1;
      if (!event.owner_name) return tv(many ? "liveEvents.joinedManyNoOwner" : "liveEvents.joinedNoOwner", { names });
      return tv(many ? "liveEvents.joinedMany" : "liveEvents.joined", { names, owner: event.owner_name });
    }
  }
}

/** "ד׳ 18.11 08:00 · יונדאי 1" (the car only when known). */
export function liveEventWhen(event: Pick<BoardLiveEvent, "starts_at" | "car_name">): string {
  const parts: string[] = [];
  if (event.starts_at) parts.push(`${formatDayDate(event.starts_at)} ${formatTime(new Date(event.starts_at))}`);
  if (event.car_name) parts.push(event.car_name);
  return parts.join(" · ");
}

/** How many events are after the marker. */
export function newEventCount(events: readonly Pick<BoardLiveEvent, "id">[], seenAuditId: number): number {
  return events.filter((event) => event.id > seenAuditId).length;
}

/**
 * The lines of this visit: everything after the marker the visit began with (`baseline`), so opening the strip (which
 * moves the marker) does not empty it.
 */
export function visitEvents<T extends Pick<BoardLiveEvent, "id">>(events: readonly T[], baseline: number): T[] {
  return events.filter((event) => event.id > baseline);
}
