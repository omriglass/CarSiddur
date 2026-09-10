import type { z } from "zod";

import type { departmentStatsSchema, weekdayStatSchema } from "./schema";

export type WeekdayStat = z.infer<typeof weekdayStatSchema>;
export type DepartmentStats = z.infer<typeof departmentStatsSchema>;
