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
  | "proposal_already_sent"
  | "proposal_not_draft"
  | "proposal_replacement_answered"
  | "request_outside_week"
  | "proposal_expired"
  | "proposal_not_answerable"
  | "invalid_token"
  | "offer_not_found"
  | "ride_unavailable"
  | "ride_wrong_day"
  | "ride_same_day"
  | "ride_change_pending"
  | "ride_needs_coordinator"
  | "ride_change_closed"
  | "ride_no_conflict"
  | "week_archived"
  | "publication_scores_invalid"
  | "publication_days_invalid"
  | "publication_conflicts"
  | "publication_unanswered"
  | "pending_ride_changes"
  | "request_window_closed"
  | "driver_unavailable"
  | "driver_assigned"
  | "ride_past"
  | "preferred_car_invalid"
  | "consent_required"
  | "ride_description_invalid"
  | "passenger_names_invalid"
  | "companions_invalid"
  | "passenger_count_mismatch"
  | "quick_ride_unavailable"
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
  proposal_already_sent: "proposal_already_sent",
  proposal_not_draft: "proposal_not_draft",
  proposal_replacement_answered: "proposal_replacement_answered",
  request_outside_week: "request_outside_week",
  proposal_expired: "proposal_expired",
  proposal_not_answerable: "proposal_not_answerable",
  invalid_token: "invalid_token",
  offer_not_found: "offer_not_found",
  car_unavailable: "ride_unavailable",
  ride_conflicts_with_maintenance: "ride_unavailable",
  ride_seats_do_not_fit: "ride_unavailable",
  ride_request_day_mismatch: "ride_wrong_day",
  ride_outside_week: "ride_wrong_day",
  ride_must_end_same_day: "ride_same_day",
  ride_change_already_pending: "ride_change_pending",
  shared_ride_requires_sadran: "ride_needs_coordinator",
  ride_change_not_found: "ride_change_closed",
  ride_change_not_pending: "ride_change_closed",
  no_conflicting_ride: "ride_no_conflict",
  week_archived: "week_archived",
  invalid_publication_scores: "publication_scores_invalid",
  invalid_publication_days: "publication_days_invalid",
  publication_conflicts: "publication_conflicts",
  publication_unanswered: "publication_unanswered",
  pending_ride_changes: "pending_ride_changes",
  request_window_closed: "request_window_closed",
  request_not_editable: "request_window_closed",
  seat_config_violation: "ride_unavailable",
  temporary_car_owner_only: "ride_unavailable",
  driver_already_busy: "driver_unavailable",
  ride_driver_already_assigned: "driver_assigned",
  ride_in_past: "ride_past",
  invalid_preferred_car: "preferred_car_invalid",
  proposal_consent_required: "consent_required",
  ride_time_overlap: "ride_unavailable",
  ride_turnaround_conflict: "ride_unavailable",
  invalid_ride_description: "ride_description_invalid",
  invalid_passenger_names: "passenger_names_invalid",
  invalid_companions: "companions_invalid",
  passenger_names_exceed_seats: "passenger_count_mismatch",
  invalid_quick_reservation: "quick_ride_unavailable",
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
  proposal_already_sent: he.sadranProposal.alreadySent,
  proposal_not_draft: he.sadranProposal.noLongerDraft,
  proposal_replacement_answered: he.sadranProposal.replacementAnswered,
  request_outside_week: he.memberErrors.requestOutsideWeek,
  proposal_expired: he.memberErrors.proposalExpired,
  proposal_not_answerable: he.memberErrors.proposalNotAnswerable,
  invalid_token: he.memberErrors.invalidToken,
  offer_not_found: he.memberErrors.offerNotFound,
  ride_unavailable: he.rideEditing.unavailable,
  ride_wrong_day: he.rideEditing.wrongDay,
  ride_same_day: he.boardCoordination.sameDayOnly,
  ride_change_pending: he.rideEditing.alreadyPending,
  ride_needs_coordinator: he.rideEditing.needsCoordinator,
  ride_change_closed: he.rideEditing.noLongerPending,
  ride_no_conflict: he.rideEditing.noConflict,
  week_archived: he.rideEditing.archived,
  publication_scores_invalid: he.publishScores.invalid,
  publication_days_invalid: he.publicationFlow.noSelection,
  publication_conflicts: he.sadranPublish.blockedByConflicts,
  publication_unanswered: he.publicationFlow.unresolvedHelp,
  pending_ride_changes: he.rideEditing.pendingPublish,
  request_window_closed: he.request.editWindowClosed,
  driver_unavailable: he.rideCoordination.driverBusy,
  driver_assigned: he.rideCoordination.noLongerMissing,
  ride_past: he.rideCoordination.past,
  preferred_car_invalid: he.rideCoordination.invalidPreferredCar,
  consent_required: he.rideCoordination.awaitingConsent,
  ride_description_invalid: he.ridePublicDetails.invalidDescription,
  passenger_names_invalid: he.ridePublicDetails.invalidGuestNames,
  companions_invalid: he.ridePublicDetails.invalidCompanions,
  passenger_count_mismatch: he.ridePublicDetails.namesExceedSeats,
  quick_ride_unavailable: he.ridePublicDetails.invalidQuickReservation,
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
  /**
   * Postgrest's `error.details` — set from a PL/pgSQL `raise ... using
   * detail = ...` (e.g. `assert_car_chain`'s bug-fix pass update,
   * `supabase/migrations/20260907093300_apply_solver_result_atomic_summary.sql`,
   * which now puts the car's name and the offending ride's time window
   * there). Appended to the toast message below for the few codes where a
   * generic sentence alone would not identify *which* ride broke — the
   * MAJOR BUG investigation's "never silently partial, never anonymous"
   * requirement for apply_solver_result/edit_ride failures.
   */
  details?: string | null;
}

/** Codes whose Hebrew message is generic on its own; `error.details` (when present) names the specific ride/car. */
const CODES_NAMING_THE_RIDE = new Set<ErrorCode>(["car_chain_broken", "car_away_at_day_end"]);

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
  // Recognize this specific constraint for older servers and concurrency races;
  // other uniqueness errors must retain their own meaning.
  const bySqlstate = pgError?.code === "23505" && pgError.message?.includes('"proposals_one_sent_per_request_idx"')
    ? "proposal_already_sent"
    : pgError?.code ? SQLSTATE_TO_CODE[pgError.code] : undefined;
  const code = byMessage ?? bySqlstate ?? "unknown";
  const baseMessage = CODE_TO_MESSAGE[code];
  const message =
    CODES_NAMING_THE_RIDE.has(code) && pgError?.details ? `${baseMessage} (${pgError.details})` : baseMessage;
  return new AppError(code, message);
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
