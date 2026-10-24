/** Query keys of the car handover checklist (REQ item 150 d). */
export const checklistKeys = {
  all: ["carChecklist"] as const,
  items: (departmentId: string | undefined) => [...checklistKeys.all, "items", departmentId] as const,
  status: (carId: string | undefined) => [...checklistKeys.all, "status", carId] as const,
  history: (carId: string | undefined) => [...checklistKeys.all, "history", carId] as const,
  prompts: (profileId: string | undefined) => [...checklistKeys.all, "prompts", profileId] as const,
};
