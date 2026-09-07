/** A merge must preserve both requested journeys, even if the pointer is dropped
 * in the middle of the host. Placement of the pointer is not a new departure.
 */
export function expandedMergeWindow(
  host: { startsAt: string; endsAt: string },
  guest: { startsAt: string; endsAt: string },
): { startsAt: string; endsAt: string } {
  return {
    startsAt: new Date(Math.min(Date.parse(host.startsAt), Date.parse(guest.startsAt))).toISOString(),
    endsAt: new Date(Math.max(Date.parse(host.endsAt), Date.parse(guest.endsAt))).toISOString(),
  };
}
