import { describe, expect, it } from "vitest";

import * as enums from "./enums";

/**
 * Every `*_SCHEMA` in `enums.ts` is a `z.enum(ARRAY)`, so this test only
 * needs to check (a) no duplicates in the array and (b) the schema's own
 * options match the array exactly (they always will, since the schema is
 * built from the array — this guards against a future hand-edit splitting
 * the two). It cannot check that the array's *length* matches the number of
 * literals in the generated `Database["public"]["Enums"][...]` type — that
 * is a type-level fact, not a runtime one — so that direction is covered
 * entirely by each `assertSameEnum<>()` call in `enums.ts`, which fails
 * `npm run typecheck` if a value is missing on either side.
 */
const ARRAYS: Record<string, { array: readonly string[]; schema: { options: readonly string[] } }> = {
  ROLES: { array: enums.ROLES, schema: enums.roleSchema },
  APPROVAL_STATUSES: { array: enums.APPROVAL_STATUSES, schema: enums.approvalStatusSchema },
  WEEK_PHASES: { array: enums.WEEK_PHASES, schema: enums.weekPhaseSchema },
  REQUEST_STATUSES: { array: enums.REQUEST_STATUSES, schema: enums.requestStatusSchema },
  TRIP_SHAPES: { array: enums.TRIP_SHAPES, schema: enums.tripShapeSchema },
  LEG_CAR_MODES: { array: enums.LEG_CAR_MODES, schema: enums.legCarModeSchema },
  HOME_WEEK_PREFERENCES: { array: enums.HOME_WEEK_PREFERENCES, schema: enums.homeWeekPreferenceSchema },
  RIDE_STATUSES: { array: enums.RIDE_STATUSES, schema: enums.rideStatusSchema },
  RIDE_ROLES: { array: enums.RIDE_ROLES, schema: enums.rideRoleSchema },
  RIDE_LEGS: { array: enums.RIDE_LEGS, schema: enums.rideLegSchema },
  PROPOSAL_TYPES: { array: enums.PROPOSAL_TYPES, schema: enums.proposalTypeSchema },
  PROPOSAL_STATUSES: { array: enums.PROPOSAL_STATUSES, schema: enums.proposalStatusSchema },
  PARTY_RESPONSES: { array: enums.PARTY_RESPONSES, schema: enums.partyResponseSchema },
  CAR_TYPES: { array: enums.CAR_TYPES, schema: enums.carTypeSchema },
  CAR_STATUSES: { array: enums.CAR_STATUSES, schema: enums.carStatusSchema },
  CAR_ISSUE_STATUSES: { array: enums.CAR_ISSUE_STATUSES, schema: enums.carIssueStatusSchema },
  CAR_ISSUE_CATEGORIES: { array: enums.CAR_ISSUE_CATEGORIES, schema: enums.carIssueCategorySchema },
  CAR_CARE_KINDS: { array: enums.CAR_CARE_KINDS, schema: enums.carCareKindSchema },
  TIRE_STATES: { array: enums.TIRE_STATES, schema: enums.tireStateSchema },
  SOLVER_RUN_STATUSES: { array: enums.SOLVER_RUN_STATUSES, schema: enums.solverRunStatusSchema },
  FREED_OFFER_STATUSES: { array: enums.FREED_OFFER_STATUSES, schema: enums.freedOfferStatusSchema },
  FREED_CLAIM_STATUSES: { array: enums.FREED_CLAIM_STATUSES, schema: enums.freedClaimStatusSchema },
  NOTIFICATION_CHANNELS: { array: enums.NOTIFICATION_CHANNELS, schema: enums.notificationChannelSchema },
  NOTIFICATION_EVENTS: { array: enums.NOTIFICATION_EVENTS, schema: enums.notificationEventSchema },
  PUSH_OUTBOX_STATUSES: { array: enums.PUSH_OUTBOX_STATUSES, schema: enums.pushOutboxStatusSchema },
  ANSWER_CHANNELS: { array: enums.ANSWER_CHANNELS, schema: enums.answerChannelSchema },
  AUDIT_ACTIONS: { array: enums.AUDIT_ACTIONS, schema: enums.auditActionSchema },
  WAITLIST_GROUP_STATUSES: { array: enums.WAITLIST_GROUP_STATUSES, schema: enums.waitlistGroupStatusSchema },
};

describe("enums.ts arrays", () => {
  it("covers the 24 canonical notification events (UX_FLOWS.md §6.1)", () => {
    expect(enums.NOTIFICATION_EVENTS).toHaveLength(24);
  });

  it("orders week_phase with upcoming first (2026-09-10 alter type … add value … before 'open')", () => {
    expect(enums.WEEK_PHASES[0]).toBe("upcoming");
    expect(enums.WEEK_PHASES[1]).toBe("open");
  });

  for (const [name, { array, schema }] of Object.entries(ARRAYS)) {
    it(`${name} has no duplicates`, () => {
      expect(new Set(array).size).toBe(array.length);
    });

    it(`${name} matches its zod schema's options exactly`, () => {
      expect([...schema.options]).toEqual([...array]);
    });
  }
});
