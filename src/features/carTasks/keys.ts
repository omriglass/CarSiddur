/** Query keys for tasks for the next user of a car (REQ item 150 b). */
export const carTaskKeys = {
  all: ["carTasks"] as const,
  /** The signed-in member's visible tasks (`my_car_tasks()`, window rule applied by the server). */
  mine: () => [...carTaskKeys.all, "mine"] as const,
  /** A car's tasks for its managers (`car_tasks` table, RLS = `can_manage_car`). */
  car: (carId: string | undefined) => [...carTaskKeys.all, "car", carId] as const,
};
