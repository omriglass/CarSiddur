import { afterEach, describe, expect, it, vi } from "vitest";

import { he } from "@/i18n/he";
import { toAppError } from "./rpc";

describe("proposal send errors", () => {
  it("explains a pending-proposal conflict from the RPC", () => {
    expect(toAppError({ code: "P0001", message: "proposal_already_sent" })).toMatchObject({
      code: "proposal_already_sent", message: he.sadranProposal.alreadySent,
    });
  });

  it("recognizes the existing database constraint without mislabeling other uniqueness errors", () => {
    expect(toAppError({ code: "23505", message: 'duplicate key value violates unique constraint "proposals_one_sent_per_request_idx"' }).message)
      .toBe(he.sadranProposal.alreadySent);
    // Any other unique-constraint violation is a generic "duplicate value" — not the
    // opaque `unknown` fallback (owner decision 2026-09-10, surface unmapped DB errors).
    expect(toAppError({ code: "23505", message: 'duplicate key value violates unique constraint "profiles_pkey"' }))
      .toMatchObject({ code: "duplicate_value", message: he.errors.duplicateValue });
  });

  it("distinguishes an answered replacement from an already sent draft", () => {
    expect(toAppError({ message: "proposal_replacement_answered" }).message).toBe(he.sadranProposal.replacementAnswered);
    expect(toAppError({ message: "proposal_not_draft" }).message).toBe(he.sadranProposal.noLongerDraft);
  });

  it("explains a proposal refused because its day is already published (20260910098000)", () => {
    expect(toAppError({ code: "P0001", message: "proposal_day_public" })).toMatchObject({
      code: "proposal_day_public", message: he.errors.proposalDayPublic,
    });
  });

  it("classifies push-subscription failures into a copyable diagnostic code", () => {
    expect(toAppError(new Error("push_vapid_key_invalid"))).toMatchObject({
      code: "push_vapid_key_invalid", message: he.errors.pushVapidKeyInvalid,
    });
  });
});

describe("unmapped database errors (owner decision 2026-09-10)", () => {
  afterEach(() => vi.restoreAllMocks());

  it("maps a check-constraint violation (e.g. a temporary car with no owner) to a helpful Hebrew message", () => {
    expect(toAppError({ code: "23514", message: 'new row for relation "cars" violates check constraint "cars_temporary_owner_ck"' }))
      .toMatchObject({ code: "constraint_violation", message: he.errors.constraintViolation });
  });

  it("logs the raw Postgres error and forwards details/hint as a toast description when a code falls through to unknown", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const appError = toAppError({ code: "99999", message: "something_new", details: "car ref 123", hint: null });
    expect(appError.code).toBe("unknown");
    expect(appError.description).toBe("car ref 123");
    expect(spy).toHaveBeenCalledWith("Unmapped database error", {
      code: "99999", message: "something_new", details: "car ref 123", hint: null,
    });
  });

  it("falls back to the hint when there is no details, and leaves description unset when neither is present", () => {
    expect(toAppError({ code: "99999", message: "x", hint: "try again later" }).description).toBe("try again later");
    expect(toAppError({ code: "99999", message: "x" }).description).toBeUndefined();
  });
});
