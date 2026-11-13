/**
 * PC1 (REQ item 227): a private car may have several owners (`car_owners`). Car reads embed
 * `owners:car_owners(profile_id)` and flatten it to `owner_ids`; `cars.owner_id` is only the first owner (a mirror).
 * Every "is this my private car?" check in the browser goes through `isCarOwner` — the server's `is_car_owner()` decides
 * for real.
 */
export interface CarOwnership {
  type: string;
  owner_id: string | null;
  /** All owners, when the read embedded them; absent = only `owner_id` is known. */
  owner_ids?: readonly string[];
}

export const CAR_OWNERS_EMBED = "owners:car_owners(profile_id)";

export function carOwnerIds(car: CarOwnership | null | undefined): readonly string[] {
  if (!car || car.type !== "temporary") return [];
  return car.owner_ids ?? (car.owner_id ? [car.owner_id] : []);
}

export function isCarOwner(car: CarOwnership | null | undefined, profileId: string | null | undefined): boolean {
  return !!profileId && carOwnerIds(car).includes(profileId);
}

/** `{ owners: [{ profile_id }] }` (the embed) → `{ owner_ids: [...] }`. */
export function flattenCarOwners<T extends { owners?: { profile_id: string }[] | null }>(row: T): Omit<T, "owners"> & { owner_ids: string[] } {
  const { owners, ...rest } = row;
  return { ...rest, owner_ids: (owners ?? []).map((o) => o.profile_id) };
}
