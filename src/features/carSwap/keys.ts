/** Query keys for the `carSwap` feature (CLAUDE.md "Structure"). */
export const carSwapKeys = {
  all: ["carSwap"] as const,
  preview: (departmentId: string, weekStart: string, day: string, carA: string, carB: string) =>
    [...carSwapKeys.all, "preview", departmentId, weekStart, day, carA, carB] as const,
};
