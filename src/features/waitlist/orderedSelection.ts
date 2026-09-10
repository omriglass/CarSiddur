/**
 * `resolve_waitlist_group(p_request_ids)`'s first element is the driver
 * (DATA_MODEL.md §7.4a). Puts `driverId` first among the ticked ids,
 * preserving the relative order of everybody else. Falls back to the ticked
 * list unchanged when there is no driver to put first (e.g. nothing ticked
 * yet, or the chosen driver id isn't actually among the ticked ids).
 */
export function orderedSelection(ticked: readonly string[], driverId: string | null): string[] {
  if (!driverId || !ticked.includes(driverId)) return [...ticked];
  return [driverId, ...ticked.filter((id) => id !== driverId)];
}
