import { afterEach, describe, expect, it, vi } from "vitest";

const supabaseRpc = vi.fn();
vi.mock("@/integrations/supabase/client", () => ({ supabase: { rpc: (...args: unknown[]) => supabaseRpc(...args) } }));

import { registerRpcRefusalAsker, rpc } from "./rpc";

const busy = { code: "P0001", message: "person_busy", details: "{}" };

describe("rpc() asks a refusal that is a question, then calls again (owner 2026-11-10)", () => {
  afterEach(() => { supabaseRpc.mockReset(); registerRpcRefusalAsker(null); });

  it("calls again with the asker's arguments", async () => {
    supabaseRpc.mockResolvedValueOnce({ data: null, error: busy }).mockResolvedValueOnce({ data: { status: "waitlisted" }, error: null });
    registerRpcRefusalAsker(async (_name, args) => ({ ...(args as object), confirmed: true }));
    expect(await rpc("enter_waiting_list", { p_payload: {} })).toEqual({ status: "waitlisted" });
    expect(supabaseRpc.mock.calls[1]).toEqual(["enter_waiting_list", { p_payload: {}, confirmed: true }]);
  });

  it("throws the refusal when the asker has nothing to retry", async () => {
    supabaseRpc.mockResolvedValue({ data: null, error: busy });
    registerRpcRefusalAsker(async () => null);
    await expect(rpc("enter_waiting_list", { p_payload: {} })).rejects.toMatchObject({ code: "person_busy" });
    expect(supabaseRpc).toHaveBeenCalledTimes(1);
  });
});
