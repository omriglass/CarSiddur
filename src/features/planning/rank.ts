// REQ §13.154 (d): "מתי הכי פנוי?" — pure ranking over the month view's days. No React, no Supabase.
import { weekdayOfDate } from "@/components/dateFieldDates";

import type { Parts, PlanningDay, PlanningSettings } from "./api";

export type Part = keyof Parts;
/** A part of the day, or the whole day (07–22). */
export type DayPick = Part | "f";
export type PickJoin = "and" | "or";
/** "reservations" = reservations only; "typical" = reservations + the weekday's typical usage. */
export type RankMode = "reservations" | "typical";
/** 3 = ★★★ (the best option), 2 = ★★ (the next two), 1 = ★ (the two after). */
export type StarTier = 1 | 2 | 3;

export const PARTS: readonly Part[] = ["m", "a", "e"];
const TIERS: readonly StarTier[] = [3, 2, 2, 1, 1];

export interface RankContext {
  mode: RankMode;
  /** Typical cars in use per weekday (0 = Sunday); `null` = no history (counts as 0). */
  typical: Parts[] | null;
  settings: PlanningSettings;
}

/** A day can be reserved: its week is not open yet and it is after today. */
export function isPlannable(day: PlanningDay, today: string): boolean {
  return (day.phase === null || day.phase === "upcoming") && day.date > today;
}

function partsOf(pick: DayPick): readonly Part[] {
  return pick === "f" ? PARTS : [pick];
}

/** Share of the shared cars taken during `pick` (its worst part); Infinity when no car is available. */
export function occupancy(day: PlanningDay, pick: DayPick, ctx: RankContext): number {
  const dow = weekdayOfDate(day.date);
  let worst = 0;
  for (const part of partsOf(pick)) {
    const typical = ctx.mode === "typical" ? (ctx.typical?.[dow]?.[part] ?? 0) : 0;
    const capacity = day.available[part] * (ctx.mode === "typical" ? ctx.settings.carMultiplier : 1);
    const share = capacity > 0 ? (day.reserved[part] + typical) / capacity : Number.POSITIVE_INFINITY;
    worst = Math.max(worst, share);
  }
  return worst;
}

/** The whole day's load, for the month's shading. */
export function dayLoad(day: PlanningDay, ctx: RankContext): number {
  return occupancy(day, "f", ctx);
}

function weeksBetween(fromWeekStart: string, toWeekStart: string): number {
  return Math.round((Date.parse(`${toWeekStart}T12:00:00Z`) - Date.parse(`${fromWeekStart}T12:00:00Z`)) / (7 * 86_400_000));
}

function weekStartOf(date: string): string {
  const d = new Date(`${date}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() - weekdayOfDate(date));
  return d.toISOString().slice(0, 10);
}

interface Option {
  dates: string[];
  occupancy: number;
  score: number;
}

/**
 * The best options for `picks` (weekday → part), as date → star tier. "and": every picked weekday of one week together;
 * "or": any single picked day. An option at or above the "full" share gets nothing; score = week cost × weeks ahead +
 * how far the option is above "good" (lower is better), then the emptier, then the earlier.
 */
export function rankOptions(
  days: readonly PlanningDay[],
  picks: Readonly<Partial<Record<number, DayPick>>>,
  join: PickJoin,
  ctx: RankContext,
  today: string,
): Map<string, StarTier> {
  const picked = Object.entries(picks).flatMap(([dow, pick]) => (pick ? [[Number(dow), pick] as const] : []));
  const result = new Map<string, StarTier>();
  if (picked.length === 0) return result;

  const thisWeek = weekStartOf(today);
  const byWeek = new Map<string, Map<number, PlanningDay>>();
  for (const day of days) {
    if (!isPlannable(day, today)) continue;
    const week = weekStartOf(day.date);
    const map = byWeek.get(week) ?? new Map<number, PlanningDay>();
    map.set(weekdayOfDate(day.date), day);
    byWeek.set(week, map);
  }

  const options: Option[] = [];
  const add = (week: string, chosen: { day: PlanningDay; pick: DayPick }[]) => {
    const occ = Math.max(...chosen.map(({ day, pick }) => occupancy(day, pick, ctx)));
    if (occ >= ctx.settings.full) return;
    const score = ctx.settings.weekCost * weeksBetween(thisWeek, week) + Math.max(0, occ - ctx.settings.good);
    options.push({ dates: chosen.map(({ day }) => day.date), occupancy: occ, score });
  };
  for (const [week, byDow] of byWeek) {
    if (join === "and" || picked.length === 1) {
      const chosen = picked.map(([dow, pick]) => ({ day: byDow.get(dow), pick }));
      if (chosen.every((c): c is { day: PlanningDay; pick: DayPick } => !!c.day)) add(week, chosen);
    } else {
      for (const [dow, pick] of picked) {
        const day = byDow.get(dow);
        if (day) add(week, [{ day, pick }]);
      }
    }
  }

  options.sort((a, b) => a.score - b.score || a.occupancy - b.occupancy || a.dates[0]!.localeCompare(b.dates[0]!));
  options.slice(0, TIERS.length).forEach((option, i) => {
    for (const date of option.dates) if (!result.has(date)) result.set(date, TIERS[i]!);
  });
  return result;
}
