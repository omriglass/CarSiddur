import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { isDecisive, pollFreedSlotThanks, winnerNameOf, type RawFreedOfferOutcome } from "./freedSlotThanks";

vi.mock("./api", () => ({ fetchFreedOfferOutcome: vi.fn() }));

const won = (name: string | null): RawFreedOfferOutcome => ({
  status: "auto_assigned", winning_request_id: "r1", winner: { requester: { full_name: name } },
});
const open: RawFreedOfferOutcome = { status: "open", winning_request_id: null, winner: null };

describe("winnerNameOf", () => {
  it("returns the auto-assigned winner's name", () => expect(winnerNameOf([won(" דנה ")])).toBe("דנה"));
  it("is null for no winner, claims or missing name", () => {
    expect(winnerNameOf([])).toBeNull();
    expect(winnerNameOf([open])).toBeNull();
    expect(winnerNameOf([{ ...open, status: "closed" }])).toBeNull();
    expect(winnerNameOf([won(null)])).toBeNull();
  });
  it("isDecisive only when nothing is open", () => {
    expect(isDecisive([open])).toBe(false);
    expect(isDecisive([{ ...open, status: "closed" }])).toBe(true);
  });
});

describe("pollFreedSlotThanks", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("notifies once when the winner appears", async () => {
    const fetchOutcome = vi.fn().mockResolvedValueOnce([open]).mockResolvedValue([won("דנה")]);
    const notify = vi.fn();
    pollFreedSlotThanks("ride", fetchOutcome, notify);
    await vi.advanceTimersByTimeAsync(1000);
    expect(fetchOutcome).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(2000);
    expect(notify).toHaveBeenCalledWith("דנה");
    await vi.advanceTimersByTimeAsync(20000);
    expect(fetchOutcome).toHaveBeenCalledTimes(2);
    expect(notify).toHaveBeenCalledTimes(1);
  });

  it("stops after ~10s, silently, even on errors", async () => {
    const fetchOutcome = vi.fn().mockRejectedValue(new Error("x"));
    const notify = vi.fn();
    pollFreedSlotThanks("ride", fetchOutcome, notify);
    await vi.advanceTimersByTimeAsync(30000);
    expect(fetchOutcome.mock.calls.length).toBeGreaterThanOrEqual(4);
    expect(fetchOutcome.mock.calls.length).toBeLessThanOrEqual(6);
    expect(notify).not.toHaveBeenCalled();
  });

  it("cancel stops everything", async () => {
    const fetchOutcome = vi.fn().mockResolvedValue([open]);
    const cancel = pollFreedSlotThanks("ride", fetchOutcome, vi.fn());
    cancel();
    await vi.advanceTimersByTimeAsync(20000);
    expect(fetchOutcome).not.toHaveBeenCalled();
  });
});
