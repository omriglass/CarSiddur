// PS1 (owner 2026-11-22; REQ §13.100 amended): "+ נוסעים" adds the person, nothing more. When a picked member has an
// open request at the ride's hours (`fetchRideAddMatches`), the person adding is asked "ל-X יש בקשה … להוסיף לכאן את
// הבקשה?"; a yes sends that request along (`merge_request_id`) and it joins the ride as a merge. A merge the server
// refuses comes back as `merge_refused` naming the person, and the dialog offers to add them without the request.
// Pure, unit-tested (`addPassengerMatches.test.ts`).
import { z } from "zod";

import { AppError } from "@/lib/rpc";

import type { RidePassengerInput } from "./api";

const refusalSchema = z.object({
  person_id: z.string(),
  name: z.string().nullable().optional(),
  code: z.string().nullable().optional(),
  needs: z.array(z.enum(["large_trunk", "tow_hitch"])).nullable().optional(),
});

export interface MergeRefusal {
  personId: string;
  name: string;
  code: string | null;
  needs: ("large_trunk" | "tow_hitch")[];
}

/** The `merge_refused` refusal's person and reason, or `null` for any other error. */
export function mergeRefusalOf(error: unknown): MergeRefusal | null {
  if (!(error instanceof AppError) || error.code !== "merge_refused" || !error.detail) return null;
  try {
    const parsed = refusalSchema.safeParse(JSON.parse(error.detail));
    if (!parsed.success) return null;
    return { personId: parsed.data.person_id, name: parsed.data.name ?? "", code: parsed.data.code ?? null, needs: parsed.data.needs ?? [] };
  } catch {
    return null;
  }
}

/** The same rows with that person's request no longer sent along (they are added on their own). */
export function withoutMerge(passengers: readonly RidePassengerInput[], personId: string): RidePassengerInput[] {
  return passengers.map((passenger) => {
    if (passenger.person_id !== personId || !passenger.merge_request_id) return passenger;
    const rest = { ...passenger };
    delete rest.merge_request_id;
    return rest;
  });
}

/** The rows with the requests the person adding said yes to (person id -> request id). */
export function withMerges(passengers: readonly RidePassengerInput[], yes: ReadonlyMap<string, string>): RidePassengerInput[] {
  return passengers.map((passenger) => {
    const requestId = passenger.person_id ? yes.get(passenger.person_id) : undefined;
    return requestId ? { ...passenger, merge_request_id: requestId } : passenger;
  });
}
