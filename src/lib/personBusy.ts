// REQ §13.176 (owner 2026-11-01): someone already on another ride at that time - only their own part of it counts - is
// asked about, never refused. The RPC refuses with `person_busy` (detail = JSON naming the person and the overlapping
// rides) unless called again with its allow flag (`p_allow_busy`, or `overlap_confirmed` for `submit_request`). The
// `api.ts` wrappers run those calls through `withPersonBusyRetry`, which asks on the one `PersonBusyHost` dialog
// (mounted in main.tsx) and retries on a yes - the same shape as `lib/smallTrunk.ts`.
import { z } from "zod";

import { he, tv } from "@/i18n/he";

import { AppError, registerRpcRefusalAsker } from "./rpc";
import { formatTime } from "./time";

const rideSchema = z.object({
  ride_id: z.string(),
  driver_name: z.string().nullable().optional(),
  is_driver: z.boolean().optional(),
  starts_at: z.string(),
  ends_at: z.string(),
});
const detailSchema = z.object({
  person_id: z.string().nullable().optional(),
  name: z.string().nullable().optional(),
  rides: z.array(rideSchema).optional(),
});

export interface PersonBusyRide {
  rideId: string;
  driverName: string | null;
  isDriver: boolean;
  /** The person's own part of that ride. */
  startsAt: string;
  endsAt: string;
}

export interface PersonBusyInfo {
  personId: string | null;
  name: string;
  rides: PersonBusyRide[];
}

/** Parses the refusal's `details` JSON; anything unreadable yields an empty info (the dialog then uses generic words). */
export function parsePersonBusyDetail(detail: string | undefined | null): PersonBusyInfo {
  const empty: PersonBusyInfo = { personId: null, name: "", rides: [] };
  if (!detail) return empty;
  try {
    const parsed = detailSchema.safeParse(JSON.parse(detail));
    if (!parsed.success) return empty;
    return {
      personId: parsed.data.person_id ?? null,
      name: parsed.data.name ?? "",
      rides: (parsed.data.rides ?? []).map((ride) => ({
        rideId: ride.ride_id, driverName: ride.driver_name ?? null, isDriver: !!ride.is_driver, startsAt: ride.starts_at, endsAt: ride.ends_at,
      })),
    };
  } catch {
    return empty;
  }
}

export function isPersonBusy(error: unknown): error is AppError {
  return error instanceof AppError && error.code === "person_busy";
}

/** "יש לך כבר נסיעה בשעות האלה: עם גלפי 15:10–17:45. להמשיך בכל זאת?" - "you" when the viewer is the person. */
export function personBusyBody(info: PersonBusyInfo, viewerId: string | null | undefined): string {
  const self = !!viewerId && info.personId === viewerId;
  const name = info.name || he.personBusy.unknownName;
  const first = info.rides[0];
  if (!first) return self ? he.personBusy.bodySelf : tv("personBusy.bodyOther", { name });
  const times = { from: formatTime(new Date(first.startsAt)), to: formatTime(new Date(first.endsAt)) };
  const ride = first.isDriver || !first.driverName
    ? tv("personBusy.rideDriving", times)
    : tv("personBusy.rideWith", { ...times, driver: first.driverName });
  return self ? tv("personBusy.bodySelfRide", { ride }) : tv("personBusy.bodyOtherRide", { name, ride });
}

export type PersonBusyAsker = (info: PersonBusyInfo) => Promise<boolean>;
let hostAsker: PersonBusyAsker | null = null;

/** `PersonBusyHost` registers the dialog here (and clears it on unmount). */
export function registerPersonBusyAsker(asker: PersonBusyAsker | null): void {
  hostAsker = asker;
}

/** Shows the shared question; `false` when no host is mounted (never go ahead without an explicit yes). */
export function askPersonBusy(info: PersonBusyInfo): Promise<boolean> {
  return hostAsker ? hostAsker(info) : Promise.resolve(false);
}

/**
 * `call(false)`, and on `person_busy` the shared question, then `call(true)`. A "no" rejects with the original refusal
 * marked `declined`, so `showErrorToast` stays silent and callers' `catch` blocks keep working.
 */
export async function withPersonBusyRetry<T>(call: (allowBusy: boolean) => Promise<T>, ask: PersonBusyAsker = askPersonBusy): Promise<T> {
  try {
    return await call(false);
  } catch (error) {
    // Already answered "no" to the question `rpc()` asked (`askPersonBusyRefusal`) - never ask twice.
    if (!isPersonBusy(error) || error.declined) throw error;
    if (!(await ask(parsePersonBusyDetail(error.detail)))) {
      error.declined = true;
      throw error;
    }
    return call(true);
  }
}

/**
 * The same call's arguments with its "go ahead" flag on - `p_allow_busy`, or `overlap_confirmed` inside a
 * `payload`/`p_payload` object (`submit_request`, `enter_waiting_list`) - or `null` when the call has no such flag
 * or already carries it.
 */
export function personBusyConfirmedArgs(args: unknown): Record<string, unknown> | null {
  if (!args || typeof args !== "object" || Array.isArray(args)) return null;
  const record = args as Record<string, unknown>;
  if ("p_allow_busy" in record) return record.p_allow_busy === true ? null : { ...record, p_allow_busy: true };
  for (const key of ["payload", "p_payload"]) {
    const payload = record[key];
    if (payload && typeof payload === "object" && !Array.isArray(payload)) {
      if ((payload as Record<string, unknown>).overlap_confirmed === true) return null;
      return { ...record, [key]: { ...(payload as Record<string, unknown>), overlap_confirmed: true } };
    }
  }
  return null;
}

/**
 * Owner 2026-11-10 (production: Agata's waiting-list entry only toasted "אפשר להמשיך בכל זאת באישור מפורש"): any
 * `person_busy` refusal of a call that can be confirmed asks here, in `rpc()`, whether or not its `api.ts` wrapper
 * uses `withPersonBusyRetry` - a yes calls again with the flag, a no ends silently.
 */
export async function askPersonBusyRefusal(_name: string, args: unknown, error: AppError, ask: PersonBusyAsker = askPersonBusy): Promise<Record<string, unknown> | null> {
  if (!isPersonBusy(error)) return null;
  const confirmed = personBusyConfirmedArgs(args);
  if (!confirmed) return null;
  if (await ask(parsePersonBusyDetail(error.detail))) return confirmed;
  error.declined = true;
  return null;
}

registerRpcRefusalAsker(askPersonBusyRefusal);
