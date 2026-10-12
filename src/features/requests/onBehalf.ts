/**
 * REQ §13.127 (a): the sentence form's "אני" chip can be taken out, which files the ride for someone else.
 * The requester is then the first named department member (in selection order) who drives (`does_not_drive` off),
 * else the first named member; the other named members stay companions and the filer is not on the ride.
 */
export interface OnBehalfMember {
  id: string;
  doesNotDrive?: boolean;
}

export function pickOnBehalfRequester(companionIds: readonly string[], members: readonly OnBehalfMember[]): string | null {
  const byId = new Map(members.map((member) => [member.id, member]));
  const driver = companionIds.find((id) => byId.get(id)?.doesNotDrive === false);
  return driver ?? companionIds[0] ?? null;
}

/** `requesterId` is null while "אני" is on (the filer is the requester) or when nobody can be picked yet. */
export function splitWho(
  values: { includeMe?: boolean; companions: readonly string[] },
  members: readonly OnBehalfMember[],
): { requesterId: string | null; companions: string[] } {
  if (values.includeMe !== false) return { requesterId: null, companions: [...values.companions] };
  const requesterId = pickOnBehalfRequester(values.companions, members);
  return { requesterId, companions: values.companions.filter((id) => id !== requesterId) };
}
