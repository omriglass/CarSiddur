/**
 * PC1 (REQ item 227): a private car may have several owners (`car_owners`). Car reads embed
 * `owners:car_owners(profile_id)` and flatten it to `owner_ids`; `cars.owner_id` is only the first owner (a mirror).
 * Every "is this my private car?" check in the browser goes through `isCarOwner` — the server's `is_car_owner()` decides
 * for real. PE1 (REQ item 263): who may *use* a private car for rides (owners, plus whoever the car's level allows —
 * `private_car_users`) goes through `mayUseCar` / `carUserIds`; the server's `may_use_private_car()` decides.
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

/** PE1: per private car id, the people besides its owners whose rides may use it (`private_car_users`). */
export type PrivateCarUsers = ReadonlyMap<string, ReadonlySet<string>>;

export function privateCarUsersMap(rows: readonly { car_id: string; person_id: string }[]): PrivateCarUsers {
  const map = new Map<string, Set<string>>();
  for (const row of rows) {
    const set = map.get(row.car_id) ?? new Set<string>();
    set.add(row.person_id);
    map.set(row.car_id, set);
  }
  return map;
}

/** The owners plus everyone the car's level lets use it (empty for a shared car). */
export function carUserIds(car: (CarOwnership & { id: string }) | null | undefined, users: PrivateCarUsers | undefined): readonly string[] {
  const owners = carOwnerIds(car);
  const others = car && car.type === "temporary" ? [...(users?.get(car.id) ?? [])] : [];
  return others.length ? [...owners, ...others.filter((id) => !owners.includes(id))] : owners;
}

/** Whether `profileId` may put rides on / edit rides of this private car (an owner, or allowed by its level). */
export function mayUseCar(car: (CarOwnership & { id: string }) | null | undefined, profileId: string | null | undefined, users: PrivateCarUsers | undefined): boolean {
  return !!profileId && carUserIds(car, users).includes(profileId);
}
