import { richLinesText, type RichLine } from "./ridePublicDetails";

interface CoordinatorRequest {
  id: string;
  notes: string | null;
  requester_full_name: string | null;
}

/** Call only with coordinator-authorized request data, never public served entries. */
export function rideCoordinatorNotes(
  served: readonly { request_id: string | null }[],
  requests: readonly CoordinatorRequest[],
): string {
  return richLinesText(rideCoordinatorNoteLines(served, requests) ?? []);
}

/** The same, each "<name>:" picked out (owner 2026-11-16); undefined when there is none. */
export function rideCoordinatorNoteLines(
  served: readonly { request_id: string | null }[],
  requests: readonly CoordinatorRequest[],
): RichLine[] | undefined {
  const requestIds = new Set(served.map((entry) => entry.request_id));
  const lines = requests.filter((request) => requestIds.has(request.id) && request.notes?.trim())
    .map((request): RichLine => [
      ...(request.requester_full_name ? [{ text: `${request.requester_full_name}:`, emphasis: true }, { text: " " }] : []),
      { text: request.notes!.trim() },
    ]);
  return lines.length ? lines : undefined;
}

/** `coordinatorNotes` (plain) and `coordinatorNoteLines` together, for grid blocks and cards. */
export function rideCoordinatorNoteFields(
  served: readonly { request_id: string | null }[],
  requests: readonly CoordinatorRequest[],
): { coordinatorNotes?: string; coordinatorNoteLines?: RichLine[] } {
  const lines = rideCoordinatorNoteLines(served, requests);
  return lines ? { coordinatorNotes: richLinesText(lines), coordinatorNoteLines: lines } : {};
}
