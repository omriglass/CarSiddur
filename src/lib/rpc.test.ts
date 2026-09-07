import { describe, expect, it } from "vitest";

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
    expect(toAppError({ code: "23505", message: 'duplicate key value violates unique constraint "profiles_pkey"' }).code)
      .toBe("unknown");
  });

  it("distinguishes an answered replacement from an already sent draft", () => {
    expect(toAppError({ message: "proposal_replacement_answered" }).message).toBe(he.sadranProposal.replacementAnswered);
    expect(toAppError({ message: "proposal_not_draft" }).message).toBe(he.sadranProposal.noLongerDraft);
  });
});
