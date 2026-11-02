import { describe, expect, it, vi } from "vitest";

import { withRideAgreementRetry } from "./rideMoveAgreement";
import { AppError } from "./rpc";

const refusal = () => new AppError("ride_move_needs_agreement", "x", undefined, "דנה כהן");

describe("withRideAgreementRetry (REQ §13.179 b)", () => {
  it("asks with the names and repeats the call agreed on a yes", async () => {
    const call = vi.fn(async (agreed: boolean) => { if (!agreed) throw refusal(); return "done"; });
    const ask = vi.fn(async () => true);
    await expect(withRideAgreementRetry(call, ask)).resolves.toBe("done");
    expect(call.mock.calls.map(([agreed]) => agreed)).toEqual([false, true]);
    expect(ask).toHaveBeenCalledWith("דנה כהן");
  });
  it("on a no, rejects marked declined and does not repeat", async () => {
    const call = vi.fn(async () => { throw refusal(); });
    const error = await withRideAgreementRetry(call, async () => false).catch((e: unknown) => e);
    expect((error as AppError).declined).toBe(true);
    expect(call).toHaveBeenCalledTimes(1);
  });
  it("lets any other error through untouched", async () => {
    const other = new AppError("stale_version", "x");
    await expect(withRideAgreementRetry(async () => { throw other; }, vi.fn())).rejects.toBe(other);
  });
});
