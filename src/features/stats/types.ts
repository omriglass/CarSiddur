import type { z } from "zod";

import type {
  cancellationsStatSchema,
  departmentStatsSchema,
  hourStatSchema,
  rideTypeStatSchema,
  sharingStatSchema,
  weekdayStatSchema,
  weeklyStatSchema,
} from "./schema";

export type WeekdayStat = z.infer<typeof weekdayStatSchema>;
export type RideTypeStat = z.infer<typeof rideTypeStatSchema>;
export type WeeklyStat = z.infer<typeof weeklyStatSchema>;
export type SharingStat = z.infer<typeof sharingStatSchema>;
export type CancellationsStat = z.infer<typeof cancellationsStatSchema>;
export type HourStat = z.infer<typeof hourStatSchema>;
export type DepartmentStats = z.infer<typeof departmentStatsSchema>;
