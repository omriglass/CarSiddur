import { describe, expect, it } from "vitest";

import { proposalPreviewText, type ProposalTextInput } from "./proposalText";

const base: ProposalTextInput = {
  template: { body: "a {{depart}}\nb {{newDepart}} c {{newReturn}}\nlink" },
  type: "shift",
  request: { depart_at: "2026-09-13T06:00:00.000Z", return_at: "2026-09-13T12:00:00.000Z" },
  requesterName: "Dan Cohen", sadranName: "S", destinationName: "", route: "", carName: "Kia",
  origin: "", newOrigin: "", driverName: "", reason: "", externalSuggestion: "",
};

describe("proposalPreviewText shift", () => {
  it("does not phrase unchanged times as a change", () => {
    const text = proposalPreviewText({ ...base, proposedDepartAt: base.request!.depart_at, proposedReturnAt: base.request!.return_at });
    expect(text).not.toContain(" c ");
    expect(text).toContain("Kia");
  });
  it("keeps the time line when times change", () => {
    expect(proposalPreviewText({ ...base, proposedDepartAt: "2026-09-13T07:00:00.000Z", proposedReturnAt: base.request!.return_at })).toContain(" c ");
  });
});
