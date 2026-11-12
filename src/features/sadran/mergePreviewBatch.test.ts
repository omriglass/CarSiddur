// PF1 B2: merge previews asked for in one tick leave as one `merge_previews` call; each caller keeps its own
// result or its own error.
import { beforeEach, describe, expect, it, vi } from "vitest";

const rpcMock = vi.hoisted(() => vi.fn());
vi.mock("@/integrations/supabase/client", () => ({ supabase: {} }));
vi.mock("@/lib/rpc", async (original) => ({ ...(await original<typeof import("@/lib/rpc")>()), rpc: rpcMock }));

import { AppError } from "@/lib/rpc";
import { fetchMergePreview } from "./api";

describe("fetchMergePreview batching", () => {
  // braces: a function returned from beforeEach would be called as its cleanup
  beforeEach(() => { rpcMock.mockReset(); });

  it("sends the tick's previews as one call, in order, and gives each caller its own answer", async () => {
    rpcMock.mockResolvedValue([
      { preview: { ok: true } },
      { error: { code: "P0001", message: "not_authorized", details: null, hint: null } },
      { preview: null },
    ]);
    const results = await Promise.allSettled([
      fetchMergePreview("ride-1", "req-1", "out"),
      fetchMergePreview("ride-2", "req-1", "return"),
      fetchMergePreview("ride-3", "req-2", "both"),
    ]);
    expect(rpcMock).toHaveBeenCalledTimes(1);
    expect(rpcMock).toHaveBeenCalledWith("merge_previews", { p_specs: [
      { ride_id: "ride-1", request_id: "req-1", leg: "out" },
      { ride_id: "ride-2", request_id: "req-1", leg: "return" },
      { ride_id: "ride-3", request_id: "req-2", leg: "both" },
    ] });
    expect(results[0].status).toBe("fulfilled");
    expect(results[1].status).toBe("rejected");
    expect((results[1] as PromiseRejectedResult).reason).toBeInstanceOf(AppError);
    expect(results[2]).toEqual({ status: "fulfilled", value: null });
  });

  it("a failed call rejects every caller of that call, and the next tick starts a new call", async () => {
    rpcMock.mockRejectedValueOnce(new AppError("network", "x"));
    const failed = await Promise.allSettled([fetchMergePreview("a", "b", "out"), fetchMergePreview("c", "d", "out")]);
    expect(failed.map((r) => r.status)).toEqual(["rejected", "rejected"]);
    rpcMock.mockResolvedValue([{ preview: null }]);
    await expect(fetchMergePreview("a", "b", "out")).resolves.toBeNull();
    expect(rpcMock).toHaveBeenCalledTimes(2);
  });

  it("more than 50 previews go out as consecutive calls", async () => {
    rpcMock.mockImplementation((_name: string, args: { p_specs: unknown[] }) => Promise.resolve(args.p_specs.map(() => ({ preview: null }))));
    await Promise.all(Array.from({ length: 70 }, (_, i) => fetchMergePreview(`r${i}`, "q", "out")));
    expect(rpcMock.mock.calls.map((call) => (call[1] as { p_specs: unknown[] }).p_specs.length)).toEqual([50, 20]);
  });
});
