/** Query keys of the car guides (REQ item 259, "איך עושים…"). */
export const guideKeys = {
  all: ["carGuides"] as const,
  topics: (departmentId: string | undefined) => [...guideKeys.all, "topics", departmentId] as const,
  car: (carId: string | undefined) => [...guideKeys.all, "car", carId] as const,
  department: (departmentId: string | undefined) => [...guideKeys.all, "department", departmentId] as const,
  withGuides: (carIds: readonly string[]) => [...guideKeys.all, "withGuides", [...carIds].sort().join(",")] as const,
  missing: (departmentId: string | undefined) => [...guideKeys.all, "missing", departmentId] as const,
};
