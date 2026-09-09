/**
 * Query keys for the car page (`/cars/:carId`, `docs/UX_FLOWS.md` §5.11 "Car
 * page (car care portal)"). Separate feature from `src/features/admin/cars`
 * (which owns the admin fleet screen and its own `carAdminKeys`) — this
 * feature is the responsible-person/admin car page, reachable outside the
 * admin section.
 */
export const carKeys = {
  all: ["cars"] as const,
  detail: (carId: string | undefined) => [...carKeys.all, "detail", carId] as const,
  issues: (carId: string | undefined) => [...carKeys.all, "issues", carId] as const,
  careEvents: (carId: string | undefined) => [...carKeys.all, "careEvents", carId] as const,
  myResponsible: (profileId: string | undefined) => [...carKeys.all, "myResponsible", profileId] as const,
};
