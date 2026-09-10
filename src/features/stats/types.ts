import type { z } from "zod";

import type { departmentStatsSchema, rideTypeStatSchema, weekdayStatSchema, weeklyStatSchema } from "./schema";

export type WeekdayStat = z.infer<typeof weekdayStatSchema>;
export type RideTypeStat = z.infer<typeof rideTypeStatSchema>;
export type WeeklyStat = z.infer<typeof weeklyStatSchema>;
export type DepartmentStats = z.infer<typeof departmentStatsSchema>;
