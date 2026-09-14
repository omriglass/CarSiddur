/**
 * Which cars the member-facing siddur grid shows for one day (REQ §6.4 / §13.80, UX_FLOWS.md
 * §3.5 wide-screen grid). A temporary (private) car is listed only on days it actually has a ride —
 * an empty private-car row says nothing useful to members (the owner's car is simply not
 * going anywhere that day) and only pushes the shared cars around. Shared cars (and the
 * board-only phantom lanes) are always shown. Pure, so `SiddurPage` and the unit test share it.
 */
export function visibleSiddurCars<C extends { id: string; group?: string }>(
  cars: readonly C[],
  ridesOfDay: readonly { carId: string }[],
): C[] {
  const carsWithRides = new Set(ridesOfDay.map((ride) => ride.carId));
  return cars.filter((car) => car.group !== "temporary" || carsWithRides.has(car.id));
}
