import { describe, expect, it } from "vitest";

import { isOfflineProposalDay } from "./offlineProposals";

const open = { phase: "open", published_days: [] as string[] };

describe("isOfflineProposalDay", () => {
  it("is off when the setting is off", () => {
    expect(isOfflineProposalDay(false, open, "2026-10-12")).toBe(false);
    expect(isOfflineProposalDay(undefined, open, "2026-10-12")).toBe(false);
  });
  it("applies to unpublished days", () => {
    expect(isOfflineProposalDay(true, open, "2026-10-12")).toBe(true);
    expect(isOfflineProposalDay(true, { phase: "solving", published_days: ["2026-10-11"] }, "2026-10-12T08:00:00+03:00")).toBe(true);
  });
  it("does not apply to published days or published/live weeks", () => {
    expect(isOfflineProposalDay(true, { phase: "solving", published_days: ["2026-10-12"] }, "2026-10-12T08:00:00+03:00")).toBe(false);
    expect(isOfflineProposalDay(true, { phase: "published", published_days: [] }, "2026-10-12")).toBe(false);
    expect(isOfflineProposalDay(true, { phase: "live", published_days: [] }, "2026-10-12")).toBe(false);
  });
  it("is off without a day", () => {
    expect(isOfflineProposalDay(true, open, null)).toBe(false);
  });
});
