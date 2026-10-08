import { beforeEach, describe, expect, it, vi } from "vitest";

import { he } from "@/i18n/he";
import { AppError } from "@/lib/rpc";
import { registerSmallTrunkAsker } from "@/lib/smallTrunk";

const rpcMock = vi.fn();
vi.mock("@/lib/rpc", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/rpc")>()), rpc: (...args: unknown[]) => rpcMock(...args) }));

import { submitRequest } from "./api";
import type { SubmitRequestPayload } from "./api";

const payload = { department_id: "d", week_start: "2026-10-18", has_luggage: true, ask_small_trunk: true } as unknown as SubmitRequestPayload;
const refusal = () => new AppError("needs_large_trunk", he.errors.needsLargeTrunk, undefined, JSON.stringify({ request_ids: ["r"], names: ["דנה"], car_name: "יונדאי 1" }));

describe("submitRequest large-trunk confirmation (REQ §13.111 a)", () => {
  beforeEach(() => { rpcMock.mockReset(); registerSmallTrunkAsker(null); });

  it("retries with allow_small_trunk after the member confirms", async () => {
    rpcMock.mockRejectedValueOnce(refusal()).mockResolvedValueOnce({ status: "assigned" });
    registerSmallTrunkAsker(() => Promise.resolve(true));
    expect(await submitRequest(payload)).toEqual({ status: "assigned" });
    expect((rpcMock.mock.calls[0]![1] as { payload: Record<string, unknown> }).payload.allow_small_trunk).toBeUndefined();
    expect((rpcMock.mock.calls[1]![1] as { payload: Record<string, unknown> }).payload.allow_small_trunk).toBe(true);
  });

  it("does not retry when the member declines", async () => {
    rpcMock.mockRejectedValue(refusal());
    registerSmallTrunkAsker(() => Promise.resolve(false));
    await expect(submitRequest(payload)).rejects.toMatchObject({ code: "needs_large_trunk", declined: true });
    expect(rpcMock).toHaveBeenCalledTimes(1);
  });
});
