/** Query keys of the all-cars dashboard (`/cars`, REQ item 150 e). Root `carsOverview` is a catalog-tier family (`lib/queryPolicy.ts`). */
export const carsOverviewKeys = {
  checklists: (departmentId: string | undefined) => ["carsOverview", "checklists", departmentId] as const,
  department: (departmentId: string | undefined) => ["carsOverview", "department", departmentId] as const,
};
