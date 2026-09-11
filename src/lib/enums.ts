import { z } from "zod";

import type { Database } from "@/integrations/supabase/types";

/**
 * Single TS home for SQL enum value lists (CLAUDE.md hard rule 9;
 * Conventions "Statuses / enums shared between SQL and TS").
 *
 * Every array below is `as const satisfies readonly Enums<'x'>[]`, ordered
 * exactly like the SQL `create type … as enum (...)` (plus any later
 * `alter type … add value`), so it doubles as display order. Each array
 * gets a derived type, a zod schema, and an `assertSameEnum<>()` check
 * against the generated `Database["public"]["Enums"]` type so a mismatch
 * (in either direction) fails `npm run typecheck` instead of silently
 * drifting.
 *
 * To extend when a SQL enum changes (CLAUDE.md Conventions steps 1-4):
 *   1. Add the value in a migration (`alter type … add value` alone in its
 *      own file, or a new `create type … as enum (...)`).
 *   2. `npm run db:types` to regenerate `src/integrations/supabase/types.ts`.
 *   3. Add/update the array here in the same order as the SQL definition.
 *   4. Add/update the Hebrew label wherever labels for that enum live
 *      today (e.g. `StatusBadge`'s `Record<X, StatusMeta>` maps) — labels
 *      are NOT centralized here, only the value lists/types/schemas are.
 *
 * `npm run db:types` must run first after any SQL enum change — this file
 * is hand-written against the generated types, not generated itself.
 */

export type Enums<T extends keyof Database["public"]["Enums"]> = Database["public"]["Enums"][T];

/**
 * Compile-time equality check: fails `npm run typecheck` if `A` and `B`
 * differ in either direction (a value added to one side but not the other).
 * The `<T>() => T extends X ? 1 : 2` trick makes the comparison invariant
 * (distributive conditional types would otherwise let `A extends B` pass
 * for overlapping-but-not-equal unions).
 */
type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2
  ? true
  : false;

export function assertSameEnum<A, B>(..._args: Equal<A, B> extends true ? [] : [never]) {
  // No runtime behavior: this function only exists to be called at module
  // scope so its generic arguments are typechecked. See the test file's
  // comment for why there is no runtime equivalent.
}

// ---------------------------------------------------------------------------
// role
// ---------------------------------------------------------------------------
export const ROLES = ["member", "sadran", "admin"] as const satisfies readonly Enums<"role">[];
export type Role = (typeof ROLES)[number];
export const roleSchema = z.enum(ROLES);
assertSameEnum<Role, Enums<"role">>();

// ---------------------------------------------------------------------------
// approval_status
// ---------------------------------------------------------------------------
export const APPROVAL_STATUSES = [
  "pending",
  "approved",
  "blocked",
] as const satisfies readonly Enums<"approval_status">[];
export type ApprovalStatus = (typeof APPROVAL_STATUSES)[number];
export const approvalStatusSchema = z.enum(APPROVAL_STATUSES);
assertSameEnum<ApprovalStatus, Enums<"approval_status">>();

// ---------------------------------------------------------------------------
// week_phase (`upcoming` inserted before `open` by
// 20260910095000_add_week_phase_upcoming.sql)
// ---------------------------------------------------------------------------
export const WEEK_PHASES = [
  "upcoming",
  "open",
  "solving",
  "published",
  "live",
  "archived",
] as const satisfies readonly Enums<"week_phase">[];
export type WeekPhase = (typeof WEEK_PHASES)[number];
export const weekPhaseSchema = z.enum(WEEK_PHASES);
assertSameEnum<WeekPhase, Enums<"week_phase">>();

// ---------------------------------------------------------------------------
// request_status
// ---------------------------------------------------------------------------
export const REQUEST_STATUSES = [
  "draft",
  "submitted",
  "proposed",
  "assigned",
  "merged",
  "waitlisted",
  "denied",
  "external",
  "withdrawn",
  "cancelled",
] as const satisfies readonly Enums<"request_status">[];
export type RequestStatus = (typeof REQUEST_STATUSES)[number];
export const requestStatusSchema = z.enum(REQUEST_STATUSES);
assertSameEnum<RequestStatus, Enums<"request_status">>();

// ---------------------------------------------------------------------------
// trip_shape
// ---------------------------------------------------------------------------
export const TRIP_SHAPES = [
  "round_trip",
  "one_way_to",
  "one_way_from",
] as const satisfies readonly Enums<"trip_shape">[];
export type TripShape = (typeof TRIP_SHAPES)[number];
export const tripShapeSchema = z.enum(TRIP_SHAPES);
assertSameEnum<TripShape, Enums<"trip_shape">>();

// ---------------------------------------------------------------------------
// leg_car_mode
// ---------------------------------------------------------------------------
export const LEG_CAR_MODES = [
  "keep",
  "relay",
  "passenger",
  "chauffeur",
] as const satisfies readonly Enums<"leg_car_mode">[];
export type LegCarMode = (typeof LEG_CAR_MODES)[number];
export const legCarModeSchema = z.enum(LEG_CAR_MODES);
assertSameEnum<LegCarMode, Enums<"leg_car_mode">>();

// ---------------------------------------------------------------------------
// home_week_preference
// ---------------------------------------------------------------------------
export const HOME_WEEK_PREFERENCES = [
  "auto",
  "live",
  "open",
] as const satisfies readonly Enums<"home_week_preference">[];
export type HomeWeekPreference = (typeof HOME_WEEK_PREFERENCES)[number];
export const homeWeekPreferenceSchema = z.enum(HOME_WEEK_PREFERENCES);
assertSameEnum<HomeWeekPreference, Enums<"home_week_preference">>();

// ---------------------------------------------------------------------------
// ride_status
// ---------------------------------------------------------------------------
export const RIDE_STATUSES = [
  "draft",
  "confirmed",
  "flagged",
  "cancelled",
] as const satisfies readonly Enums<"ride_status">[];
export type RideStatus = (typeof RIDE_STATUSES)[number];
export const rideStatusSchema = z.enum(RIDE_STATUSES);
assertSameEnum<RideStatus, Enums<"ride_status">>();

// ---------------------------------------------------------------------------
// ride_role
// ---------------------------------------------------------------------------
export const RIDE_ROLES = ["driver", "passenger"] as const satisfies readonly Enums<"ride_role">[];
export type RideRole = (typeof RIDE_ROLES)[number];
export const rideRoleSchema = z.enum(RIDE_ROLES);
assertSameEnum<RideRole, Enums<"ride_role">>();

// ---------------------------------------------------------------------------
// ride_leg
// ---------------------------------------------------------------------------
export const RIDE_LEGS = ["out", "return", "both"] as const satisfies readonly Enums<"ride_leg">[];
export type RideLeg = (typeof RIDE_LEGS)[number];
export const rideLegSchema = z.enum(RIDE_LEGS);
assertSameEnum<RideLeg, Enums<"ride_leg">>();

// ---------------------------------------------------------------------------
// proposal_type
// ---------------------------------------------------------------------------
export const PROPOSAL_TYPES = [
  "shift",
  "merge",
  "deny",
  "external",
] as const satisfies readonly Enums<"proposal_type">[];
export type ProposalType = (typeof PROPOSAL_TYPES)[number];
export const proposalTypeSchema = z.enum(PROPOSAL_TYPES);
assertSameEnum<ProposalType, Enums<"proposal_type">>();

// ---------------------------------------------------------------------------
// proposal_status
// ---------------------------------------------------------------------------
export const PROPOSAL_STATUSES = [
  "draft",
  "sent",
  "accepted",
  "declined",
  "expired",
  "applied",
  "withdrawn",
] as const satisfies readonly Enums<"proposal_status">[];
export type ProposalStatus = (typeof PROPOSAL_STATUSES)[number];
export const proposalStatusSchema = z.enum(PROPOSAL_STATUSES);
assertSameEnum<ProposalStatus, Enums<"proposal_status">>();

// ---------------------------------------------------------------------------
// party_response
// ---------------------------------------------------------------------------
export const PARTY_RESPONSES = [
  "pending",
  "accepted",
  "declined",
] as const satisfies readonly Enums<"party_response">[];
export type PartyResponse = (typeof PARTY_RESPONSES)[number];
export const partyResponseSchema = z.enum(PARTY_RESPONSES);
assertSameEnum<PartyResponse, Enums<"party_response">>();

// ---------------------------------------------------------------------------
// car_type
// ---------------------------------------------------------------------------
export const CAR_TYPES = ["shared", "temporary"] as const satisfies readonly Enums<"car_type">[];
export type CarType = (typeof CAR_TYPES)[number];
export const carTypeSchema = z.enum(CAR_TYPES);
assertSameEnum<CarType, Enums<"car_type">>();

// ---------------------------------------------------------------------------
// car_status
// ---------------------------------------------------------------------------
export const CAR_STATUSES = [
  "active",
  "maintenance",
  "retired",
] as const satisfies readonly Enums<"car_status">[];
export type CarStatus = (typeof CAR_STATUSES)[number];
export const carStatusSchema = z.enum(CAR_STATUSES);
assertSameEnum<CarStatus, Enums<"car_status">>();

// ---------------------------------------------------------------------------
// car_issue_status
// ---------------------------------------------------------------------------
export const CAR_ISSUE_STATUSES = [
  "open",
  "resolved",
] as const satisfies readonly Enums<"car_issue_status">[];
export type CarIssueStatus = (typeof CAR_ISSUE_STATUSES)[number];
export const carIssueStatusSchema = z.enum(CAR_ISSUE_STATUSES);
assertSameEnum<CarIssueStatus, Enums<"car_issue_status">>();

// ---------------------------------------------------------------------------
// car_issue_category
// ---------------------------------------------------------------------------
export const CAR_ISSUE_CATEGORIES = [
  "warning_light",
  "mechanical",
  "lighting",
  "physical_damage",
] as const satisfies readonly Enums<"car_issue_category">[];
export type CarIssueCategory = (typeof CAR_ISSUE_CATEGORIES)[number];
export const carIssueCategorySchema = z.enum(CAR_ISSUE_CATEGORIES);
assertSameEnum<CarIssueCategory, Enums<"car_issue_category">>();

// ---------------------------------------------------------------------------
// car_care_kind
// ---------------------------------------------------------------------------
export const CAR_CARE_KINDS = [
  "tire_fill",
  "wash",
] as const satisfies readonly Enums<"car_care_kind">[];
export type CarCareKind = (typeof CAR_CARE_KINDS)[number];
export const carCareKindSchema = z.enum(CAR_CARE_KINDS);
assertSameEnum<CarCareKind, Enums<"car_care_kind">>();

// ---------------------------------------------------------------------------
// tire_state
// ---------------------------------------------------------------------------
export const TIRE_STATES = [
  "ok",
  "low",
  "very_low",
] as const satisfies readonly Enums<"tire_state">[];
export type TireState = (typeof TIRE_STATES)[number];
export const tireStateSchema = z.enum(TIRE_STATES);
assertSameEnum<TireState, Enums<"tire_state">>();

// ---------------------------------------------------------------------------
// solver_run_status
// ---------------------------------------------------------------------------
export const SOLVER_RUN_STATUSES = [
  "succeeded",
  "failed",
] as const satisfies readonly Enums<"solver_run_status">[];
export type SolverRunStatus = (typeof SOLVER_RUN_STATUSES)[number];
export const solverRunStatusSchema = z.enum(SOLVER_RUN_STATUSES);
assertSameEnum<SolverRunStatus, Enums<"solver_run_status">>();

// ---------------------------------------------------------------------------
// freed_offer_status
// ---------------------------------------------------------------------------
export const FREED_OFFER_STATUSES = [
  "open",
  "auto_assigned",
  "pending_approval",
  "approved",
  "expired",
  "closed",
] as const satisfies readonly Enums<"freed_offer_status">[];
export type FreedOfferStatus = (typeof FREED_OFFER_STATUSES)[number];
export const freedOfferStatusSchema = z.enum(FREED_OFFER_STATUSES);
assertSameEnum<FreedOfferStatus, Enums<"freed_offer_status">>();

// ---------------------------------------------------------------------------
// freed_claim_status
// ---------------------------------------------------------------------------
export const FREED_CLAIM_STATUSES = [
  "offered",
  "claimed",
  "approved",
  "declined",
  "withdrawn",
] as const satisfies readonly Enums<"freed_claim_status">[];
export type FreedClaimStatus = (typeof FREED_CLAIM_STATUSES)[number];
export const freedClaimStatusSchema = z.enum(FREED_CLAIM_STATUSES);
assertSameEnum<FreedClaimStatus, Enums<"freed_claim_status">>();

// ---------------------------------------------------------------------------
// notification_channel
// ---------------------------------------------------------------------------
export const NOTIFICATION_CHANNELS = [
  "push",
  "inbox",
  "whatsapp",
  "email",
] as const satisfies readonly Enums<"notification_channel">[];
export type NotificationChannel = (typeof NOTIFICATION_CHANNELS)[number];
export const notificationChannelSchema = z.enum(NOTIFICATION_CHANNELS);
assertSameEnum<NotificationChannel, Enums<"notification_channel">>();

// ---------------------------------------------------------------------------
// notification_event (24 canonical events, UX_FLOWS.md §6.1; the last four
// were added by `alter type … add value` migrations after the base 20)
// ---------------------------------------------------------------------------
export const NOTIFICATION_EVENTS = [
  "window_open",
  "window_closing",
  "window_closed_solve_now",
  "publish_reminder",
  "published",
  "outcome_changed",
  "proposal_received",
  "proposal_answered",
  "freed_slot",
  "freed_slot_auto",
  "claim_approved",
  "claim_declined",
  "claim_contested",
  "maintenance_affects",
  "late_request",
  "waitlisted_request",
  "auto_approved",
  "request_changed",
  "access_request",
  "access_approved",
  "status_changed",
  "car_care",
  "waitlist_contested",
  "waitlist_resolved",
] as const satisfies readonly Enums<"notification_event">[];
export type NotificationEvent = (typeof NOTIFICATION_EVENTS)[number];
export const notificationEventSchema = z.enum(NOTIFICATION_EVENTS);
assertSameEnum<NotificationEvent, Enums<"notification_event">>();

// ---------------------------------------------------------------------------
// push_outbox_status
// ---------------------------------------------------------------------------
export const PUSH_OUTBOX_STATUSES = [
  "pending",
  "sent",
  "failed",
  "dead",
] as const satisfies readonly Enums<"push_outbox_status">[];
export type PushOutboxStatus = (typeof PUSH_OUTBOX_STATUSES)[number];
export const pushOutboxStatusSchema = z.enum(PUSH_OUTBOX_STATUSES);
assertSameEnum<PushOutboxStatus, Enums<"push_outbox_status">>();

// ---------------------------------------------------------------------------
// answer_channel
// ---------------------------------------------------------------------------
export const ANSWER_CHANNELS = [
  "token",
  "session",
  "sadran",
] as const satisfies readonly Enums<"answer_channel">[];
export type AnswerChannel = (typeof ANSWER_CHANNELS)[number];
export const answerChannelSchema = z.enum(ANSWER_CHANNELS);
assertSameEnum<AnswerChannel, Enums<"answer_channel">>();

// ---------------------------------------------------------------------------
// audit_action
// ---------------------------------------------------------------------------
export const AUDIT_ACTIONS = [
  "insert",
  "update",
  "delete",
] as const satisfies readonly Enums<"audit_action">[];
export type AuditAction = (typeof AUDIT_ACTIONS)[number];
export const auditActionSchema = z.enum(AUDIT_ACTIONS);
assertSameEnum<AuditAction, Enums<"audit_action">>();

// ---------------------------------------------------------------------------
// waitlist_group_status
// ---------------------------------------------------------------------------
export const WAITLIST_GROUP_STATUSES = [
  "open",
  "resolved",
  "cancelled",
] as const satisfies readonly Enums<"waitlist_group_status">[];
export type WaitlistGroupStatus = (typeof WAITLIST_GROUP_STATUSES)[number];
export const waitlistGroupStatusSchema = z.enum(WAITLIST_GROUP_STATUSES);
assertSameEnum<WaitlistGroupStatus, Enums<"waitlist_group_status">>();
