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
