import { beforeEach, describe, expect, it, vi } from "vitest";

import { ENSURE_WEEKS_TTL_MS, ensureOncePerSession, resetEnsuredWeeks } from "./ensureWeeksCache";

describe("ensureOncePerSession", () => {
  beforeEach(() => resetEnsuredWeeks());

  it("runs once per department and shares the in-flight promise", async () => {
    const run = vi.fn().mockResolvedValue(undefined);
    await Promise.all([ensureOncePerSession("d1", run), ensureOncePerSession("d1", run), ensureOncePerSession("d1", run)]);
    await ensureOncePerSession("d1", run);
    expect(run).toHaveBeenCalledTimes(1);
    await ensureOncePerSession("d2", run);
    expect(run).toHaveBeenCalledTimes(2);
  });

  it("runs again after the TTL and after a reset (sign-out)", async () => {
    const run = vi.fn().mockResolvedValue(undefined);
    await ensureOncePerSession("d1", run, 1_000);
    await ensureOncePerSession("d1", run, 1_000 + ENSURE_WEEKS_TTL_MS - 1);
    expect(run).toHaveBeenCalledTimes(1);
    await ensureOncePerSession("d1", run, 1_000 + ENSURE_WEEKS_TTL_MS);
    expect(run).toHaveBeenCalledTimes(2);
    resetEnsuredWeeks();
    await ensureOncePerSession("d1", run, 1_000 + ENSURE_WEEKS_TTL_MS);
    expect(run).toHaveBeenCalledTimes(3);
  });

  it("does not remember a failed run", async () => {
    const run = vi.fn().mockRejectedValueOnce(new Error("boom")).mockResolvedValue(undefined);
    await expect(ensureOncePerSession("d1", run)).rejects.toThrow("boom");
    await ensureOncePerSession("d1", run);
    expect(run).toHaveBeenCalledTimes(2);
  });
});
