/**
 * Which cars a `WeekGrid` shows for one day (REQ §13.80, UX_FLOWS.md §3.5 / §4.2). A temporary
 * (private) car is listed only on days it actually has a ride — an empty private-car row says
 * nothing useful (the owner's car is simply not going anywhere that day) and only pushes the
 * shared cars around. Shared cars and the board's phantom lanes are always shown. Used by the
 * member siddur (`SiddurPage`) and, since 2026-09-14 (owner), the Sadran board (`BoardScreen`).
 * Pure, so both screens and the unit test share it.
 */
export function hideIdleTemporaryCars<C extends { id: string; group?: string }>(
  cars: readonly C[],
  ridesOfDay: readonly { carId: string }[],
): C[] {
  const carsWithRides = new Set(ridesOfDay.map((ride) => ride.carId));
  return cars.filter((car) => car.group !== "temporary" || carsWithRides.has(car.id));
}

/**
 * R2B14: the place a car is away at when the selected day starts - the destination of its last
 * ride that ended before then, else where it stood at the week's start - or `undefined` when that
 * is its own base (default: the department home). So the header never shows a place on days the
 * car is back (QB21 did the same on the board).
 */
export function carAwayPlaceAtDayStart(args: {
  carId: string;
  dayStartIso: string;
  rides: readonly { car_id: string | null; ends_at: string | null; destination_id: string | null; status?: string | null }[];
  weekStartLocationId?: string | null;
  baseLocationId?: string | null;
  homeId?: string | null;
  names: ReadonlyMap<string, string>;
}): string | undefined {
  const dayStart = Date.parse(args.dayStartIso);
  const last = args.rides
    .filter((ride) => ride.car_id === args.carId && ride.status !== "cancelled" && ride.ends_at && ride.destination_id && Date.parse(ride.ends_at) <= dayStart)
    .sort((a, b) => Date.parse(b.ends_at as string) - Date.parse(a.ends_at as string))[0];
  const where = last?.destination_id ?? args.weekStartLocationId ?? null;
  const base = args.baseLocationId ?? args.homeId ?? null;
  if (!where || where === base) return undefined;
  return args.names.get(where);
}
