import { rpc } from "@/lib/rpc";
import { withSmallTrunkRetry } from "@/lib/smallTrunk";

import { carSwapPreviewSchema, carSwapResultSchema } from "./schema";

import type { CarSwapPreview, CarSwapResult, CarSwapSeriesMode } from "./schema";

/** The only file in the `carSwap` feature that calls `.rpc()` (CLAUDE.md "Structure"; REQ §13.92). */
export interface CarSwapArgs {
  departmentId: string;
  weekStart: string;
  /** `yyyy-MM-dd` — the day currently selected on the grid (`WeekGrid` always renders one day). */
  day: string;
  carA: string;
  carB: string;
}

export async function previewDayCarSwap(args: CarSwapArgs): Promise<CarSwapPreview> {
  const data = await rpc("preview_day_car_swap", {
    p_department_id: args.departmentId,
    p_week_start: args.weekStart,
    p_day: args.day,
    p_car_a: args.carA,
    p_car_b: args.carB,
  });
  return carSwapPreviewSchema.parse(data);
}

export interface SwapDayCarsArgs extends CarSwapArgs {
  expectedFingerprint: string;
  seriesMode: CarSwapSeriesMode;
}

export async function swapDayCars(args: SwapDayCarsArgs): Promise<CarSwapResult> {
  // REQ §13.111 (a): a large-luggage request landing on a car without a large trunk asks "לשבץ בכל זאת?" and retries with the flag.
  const data = await withSmallTrunkRetry((allowSmallTrunk) => rpc("swap_day_cars", {
    p_department_id: args.departmentId,
    p_week_start: args.weekStart,
    p_day: args.day,
    p_car_a: args.carA,
    p_car_b: args.carB,
    p_expected_fingerprint: args.expectedFingerprint,
    p_series_mode: args.seriesMode,
    p_allow_small_trunk: allowSmallTrunk,
  }));
  return carSwapResultSchema.parse(data);
}
