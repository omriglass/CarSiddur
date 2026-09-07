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
  const requestIds = new Set(served.map((entry) => entry.request_id));
  return requests.filter((request) => requestIds.has(request.id) && request.notes?.trim())
    .map((request) => `${request.requester_full_name ? `${request.requester_full_name}: ` : ""}${request.notes!.trim()}`)
    .join("\n");
}
