import { toast } from "sonner";

import { supabase } from "@/integrations/supabase/client";
import { he } from "@/i18n/he";

import type { Database } from "@/integrations/supabase/types";

/**
 * Typed error codes surfaced from Postgres (CLAUDE.md Conventions "Data";
 * ARCHITECTURE.md §12; DATA_MODEL.md #9/#17). RPCs raise either a custom
 * SQLSTATE (`stale_version` = P0409, `car_chain_broken` = P0410,
 * `car_away_at_day_end` = P0411, `no_home_location` = P0412) or a generic
 * `P0001` whose message *is* the identifier (`not_authorized`,
 * `week_not_open`, …) — see supabase/migrations/20260907091500_rpc.sql.
 *
 * `stale_input` (Stage 3 hardening fix #2, `apply_solver_result`'s staleness
 * check, `20260907092600_apply_solver_result_staleness.sql`) intentionally
 * shares SQLSTATE P0409 with `stale_version` — both are "someone changed the
 * data under you" conflicts — so `toAppError` below disambiguates by the
 * exception *message* (checked first) before falling back to the SQLSTATE
 * table for messages it doesn't recognize.
 */
export type ErrorCode =
  | "stale_version"
  | "stale_input"
  | "car_chain_broken"
  | "car_away_at_day_end"
  | "no_home_location"
  | "not_authorized"
  | "week_not_open"
  | "one_way_car_mode_required"
  | "manual_boost_requires_reason"
  | "request_not_found"
  | "ride_not_found"
  | "proposal_not_found"
  | "request_outside_week"
  | "proposal_expired"
  | "proposal_not_answerable"
  | "invalid_token"
  | "offer_not_found"
  | "network"
  | "unknown";

const SQLSTATE_TO_CODE: Record<string, ErrorCode> = {
  P0409: "stale_version",
  P0410: "car_chain_broken",
  P0411: "car_away_at_day_end",
  P0412: "no_home_location",
};

const MESSAGE_TO_CODE: Record<string, ErrorCode> = {
  stale_input: "stale_input",
  not_authorized: "not_authorized",
  week_not_open: "week_not_open",
  one_way_car_mode_required: "one_way_car_mode_required",
  manual_boost_requires_reason: "manual_boost_requires_reason",
  request_not_found: "request_not_found",
  ride_not_found: "ride_not_found",
  proposal_not_found: "proposal_not_found",
  request_outside_week: "request_outside_week",
  proposal_expired: "proposal_expired",
  proposal_not_answerable: "proposal_not_answerable",
  invalid_token: "invalid_token",
  offer_not_found: "offer_not_found",
};

const CODE_TO_MESSAGE: Record<ErrorCode, string> = {
  stale_version: he.errors.staleVersion,
  stale_input: he.errors.staleInput,
  car_chain_broken: he.errors.carChainBroken,
  car_away_at_day_end: he.errors.carAwayAtDayEnd,
  no_home_location: he.errors.noHomeLocation,
  not_authorized: he.errors.notAuthorized,
  week_not_open: he.errors.weekNotOpen,
  one_way_car_mode_required: he.errors.oneWayCarModeRequired,
  manual_boost_requires_reason: he.errors.manualBoostRequiresReason,
  request_not_found: he.errors.requestNotFound,
  ride_not_found: he.errors.rideNotFound,
  proposal_not_found: he.errors.proposalNotFound,
  request_outside_week: he.memberErrors.requestOutsideWeek,
  proposal_expired: he.memberErrors.proposalExpired,
  proposal_not_answerable: he.memberErrors.proposalNotAnswerable,
  invalid_token: he.memberErrors.invalidToken,
  offer_not_found: he.memberErrors.offerNotFound,
  network: he.errors.network,
  unknown: he.errors.unknown,
};

export class AppError extends Error {
  readonly code: ErrorCode;

  constructor(code: ErrorCode, message: string) {
    super(message);
    this.name = "AppError";
    this.code = code;
  }
}

interface PostgrestLikeError {
  code?: string | null;
  message?: string | null;
}

/** Maps a Postgrest/Supabase error (or unknown thrown value) to a Hebrew `AppError`. */
export function toAppError(error: unknown): AppError {
  if (error instanceof AppError) return error;
  if (error instanceof TypeError) {
    // fetch() throws a bare TypeError ("Failed to fetch") when offline.
    return new AppError("network", CODE_TO_MESSAGE.network);
  }
  const pgError = error as PostgrestLikeError | null | undefined;
  // Message first, SQLSTATE second: `stale_input` and `stale_version` share SQLSTATE
  // P0409 (see the `ErrorCode` doc comment above), so the message-keyed table — which
  // both `P0001`-style errors and this one already rely on — must win the tie.
  const byMessage = pgError?.message ? MESSAGE_TO_CODE[pgError.message] : undefined;
  const bySqlstate = pgError?.code ? SQLSTATE_TO_CODE[pgError.code] : undefined;
  const code = byMessage ?? bySqlstate ?? "unknown";
  return new AppError(code, CODE_TO_MESSAGE[code]);
}

/** Maps the error and shows a Hebrew toast (mutations' `onError`, CLAUDE.md "Data"). */
export function showErrorToast(error: unknown): AppError {
  const appError = toAppError(error);
  toast.error(appError.message);
  return appError;
}

type Functions = Database["public"]["Functions"];

/**
 * The single call site for every Postgres RPC (submit_request,
 * withdraw_request, register_push_subscription, answer_proposal, …).
 * Throws a Hebrew `AppError` on failure so callers/mutations can rely on
 * `error.message` already being toast-ready (CLAUDE.md "Data": "surface
 * `stale_version` conflicts via `lib/errors.ts`" — this is that module,
 * named `rpc.ts` because it wraps `supabase.rpc()` directly).
 */
export async function rpc<Name extends keyof Functions & string>(
  name: Name,
  args: Functions[Name]["Args"],
): Promise<Functions[Name]["Returns"]> {
  const { data, error } = await supabase.rpc(name, args as never);
  if (error) throw toAppError(error);
  return data as Functions[Name]["Returns"];
}
