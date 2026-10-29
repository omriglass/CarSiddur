/**
 * The place set `place_travel_for_week()` prices — every origin, destination and stop place of the week's requests
 * (any status; the department home is fixed) — as a short stable key (perf 2026-10-29): the board keys its travel
 * table by it instead of reloading the table after every change.
 */
export interface PlacesOfRequest {
  origin_id: string | null;
  destination_id: string | null;
  stops?: readonly { place_id: string | null }[] | null;
}

export function weekPlacesKey(requests: readonly PlacesOfRequest[]): string {
  const ids = new Set<string>();
  for (const request of requests) {
    if (request.origin_id) ids.add(request.origin_id);
    if (request.destination_id) ids.add(request.destination_id);
    for (const stop of request.stops ?? []) if (stop.place_id) ids.add(stop.place_id);
  }
  // FNV-1a over the sorted ids: a short key, and a collision costs only an estimated travel time until the next load.
  let hash = 0x811c9dc5;
  for (const char of [...ids].sort().join(",")) {
    hash ^= char.charCodeAt(0);
    hash = Math.imul(hash, 0x01000193);
  }
  return `${ids.size}:${(hash >>> 0).toString(36)}`;
}
