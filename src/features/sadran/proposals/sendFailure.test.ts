import { describe, expect, it } from "vitest";
import { shouldDiscardAfterFailedSend } from "./sendFailure";

describe("shouldDiscardAfterFailedSend (R14B6)", () => {
  it("discards a draft this click created when the server refuses the send", () => {
    expect(shouldDiscardAfterFailedSend({ message: "car_unavailable", code: "P0001" }, true)).toBe(true);
    expect(shouldDiscardAfterFailedSend({ message: "something_unmapped", code: "P0001" }, true)).toBe(true);
  });
  it("keeps a draft the Sadran opened", () => {
    expect(shouldDiscardAfterFailedSend({ message: "car_unavailable" }, false)).toBe(false);
  });
  it("keeps the draft on a network failure (the send may have arrived)", () => {
    expect(shouldDiscardAfterFailedSend(new TypeError("Failed to fetch"), true)).toBe(false);
  });
  it("keeps the draft on a gateway error or a transient database state, so the send can be retried", () => {
    expect(shouldDiscardAfterFailedSend({ message: "injected first-send failure", code: "E2E_TEMPORARY" }, true)).toBe(false);
    expect(shouldDiscardAfterFailedSend({ message: "upstream" }, true)).toBe(false);
    expect(shouldDiscardAfterFailedSend({ message: "could not serialize access", code: "40001" }, true)).toBe(false);
    expect(shouldDiscardAfterFailedSend({ message: "statement timeout", code: "57014" }, true)).toBe(false);
  });
});
