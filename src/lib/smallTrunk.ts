// REQ §13.111 (a): the large-trunk requirement can be waived by whoever places by hand. A manual
// RPC refuses with `needs_large_trunk` (detail = JSON naming the requests and the car) unless it is
// called again with `allow_small_trunk: true`. The `api.ts` wrapper of every manual-placement RPC runs
// its call through `withSmallTrunkRetry`, which asks "צריך תא מטען גדול ... לשבץ בכל זאת?" on the one
// `SmallTrunkHost` dialog (mounted in main.tsx) and retries with the flag on a yes; the board asks first
// (`askSmallTrunk`) when its own check already knows the car has no large trunk.
import { z } from "zod";

import { he, tv } from "@/i18n/he";

import { AppError } from "./rpc";

const detailSchema = z.object({
  request_ids: z.array(z.string()).optional(),
  names: z.array(z.string().nullable()).optional(),
  car_id: z.string().nullable().optional(),
  car_name: z.string().nullable().optional(),
  /** REQ §13.200: which car needs are missing (`large_trunk` / `tow_hitch`); absent in older refusals = large trunk. */
  needs: z.array(z.string()).optional(),
  /** REQ §13.200: the member whose towing request already uses the car's one hitch on the ride. */
  tow_taken_by: z.string().nullable().optional(),
});

export interface SmallTrunkInfo {
  requestIds: string[];
  /** Requesters' names, one per request (`""` when unknown). */
  names: string[];
  carId: string | null;
  carName: string | null;
  /** The missing car needs; empty = the (older) large-trunk-only refusal. */
  needs: ("large_trunk" | "tow_hitch")[];
  /** Name of the member whose towing request already holds the car's hitch on the ride, if any. */
  towTakenBy: string | null;
}

/** Parses the refusal's `details` JSON; anything unreadable yields an empty info (the dialog then uses generic words). */
export function parseSmallTrunkDetail(detail: string | undefined | null): SmallTrunkInfo {
  const empty: SmallTrunkInfo = { requestIds: [], names: [], carId: null, carName: null, needs: [], towTakenBy: null };
  if (!detail) return empty;
  try {
    const parsed = detailSchema.safeParse(JSON.parse(detail));
    if (!parsed.success) return empty;
    return {
      requestIds: parsed.data.request_ids ?? [],
      names: (parsed.data.names ?? []).map((name) => name ?? ""),
      carId: parsed.data.car_id ?? null,
      carName: parsed.data.car_name ?? null,
      needs: (parsed.data.needs ?? []).filter((n): n is "large_trunk" | "tow_hitch" => n === "large_trunk" || n === "tow_hitch"),
      towTakenBy: parsed.data.tow_taken_by ?? null,
    };
  } catch {
    return empty;
  }
}

export function isNeedsLargeTrunk(error: unknown): error is AppError {
  return error instanceof AppError && error.code === "needs_large_trunk";
}

/** The confirmation's title: the missing need (large trunk keeps its own title; towing / both say so). */
export function smallTrunkConfirmTitle(info: SmallTrunkInfo): string {
  const tow = info.needs.includes("tow_hitch");
  const trunk = info.needs.includes("large_trunk") || info.needs.length === 0;
  if (tow && trunk) return he.smallTrunk.bothTitle;
  return tow ? he.smallTrunk.towTitle : he.smallTrunk.confirmTitle;
}

/**
 * The confirmation's body: "<name>'s request needs a large trunk / a towing car, and <car> has none. Place it
 * anyway?" - worded from the missing needs; a hitch already used by another towing request says whose.
 */
export function smallTrunkConfirmBody(info: SmallTrunkInfo): string {
  const names = [...new Set(info.names.filter((name) => name.length > 0))];
  const many = info.requestIds.length > 1 || names.length > 1;
  const vars = {
    name: names.length > 0 ? names.join(", ") : he.smallTrunk.unknownName,
    car: info.carName ?? he.smallTrunk.unknownCar,
    other: info.towTakenBy ?? he.smallTrunk.unknownName,
  };
  const tow = info.needs.includes("tow_hitch");
  const trunk = info.needs.includes("large_trunk") || info.needs.length === 0;
  if (tow && trunk) return tv(many ? "smallTrunk.bothBodyMany" : "smallTrunk.bothBody", vars);
  if (tow) {
    if (info.towTakenBy) return tv("smallTrunk.towTakenBody", vars);
    return tv(many ? "smallTrunk.towBodyMany" : "smallTrunk.towBody", vars);
  }
  return tv(many ? "smallTrunk.confirmBodyMany" : "smallTrunk.confirmBody", vars);
}

/**
 * Runs `call(false)`; when the server answers `needs_large_trunk`, asks `confirm(info)` and - only on a
 * yes - runs `call(true)` (the same call with `allow_small_trunk`). Returns `undefined` when the person
 * declines; every other error propagates untouched.
 */
export async function withSmallTrunkConfirm<T>(
  call: (allowSmallTrunk: boolean) => Promise<T>,
  confirm: (info: SmallTrunkInfo) => Promise<boolean>,
): Promise<T | undefined> {
  try {
    return await call(false);
  } catch (error) {
    if (!isNeedsLargeTrunk(error)) throw error;
    if (!(await confirm(parseSmallTrunkDetail(error.detail)))) return undefined;
    return call(true);
  }
}

export type SmallTrunkAsker = (info: SmallTrunkInfo) => Promise<boolean>;
let hostAsker: SmallTrunkAsker | null = null;

/** `SmallTrunkHost` registers the dialog here (and clears it on unmount). */
export function registerSmallTrunkAsker(asker: SmallTrunkAsker | null): void {
  hostAsker = asker;
}

/** Shows the shared confirmation; `false` when no host is mounted (never place without an explicit yes). */
export function askSmallTrunk(info: SmallTrunkInfo): Promise<boolean> {
  return hostAsker ? hostAsker(info) : Promise.resolve(false);
}

/**
 * The call-site form every `api.ts` wrapper uses: `call(false)`, and on `needs_large_trunk` the shared
 * confirmation, then `call(true)`. A "no" rejects with the original refusal marked `declined`, so
 * `showErrorToast` stays silent (the person just said no) and callers' `catch` blocks keep working.
 */
export async function withSmallTrunkRetry<T>(call: (allowSmallTrunk: boolean) => Promise<T>, ask: SmallTrunkAsker = askSmallTrunk): Promise<T> {
  try {
    return await call(false);
  } catch (error) {
    if (!isNeedsLargeTrunk(error)) throw error;
    if (!(await ask(parseSmallTrunkDetail(error.detail)))) {
      error.declined = true;
      throw error;
    }
    return call(true);
  }
}
