// R21B7 (QA rerun 2026-11-15): in the app the overlap question is asked by `rpc()` itself, below `submitRequest`'s own
// retry - the "answered yes" tag must come back on that path too (the first fix only covered the wrapper's retry, and
// the form asked the overlap question again after the guest question).
import { beforeEach, describe, expect, it, vi } from "vitest";

import { registerPersonBusyAsker } from "@/lib/personBusy";

const supabaseRpc = vi.fn();
vi.mock("@/integrations/supabase/client", () => ({ supabase: { rpc: (...args: unknown[]) => supabaseRpc(...args) } }));

import { submitRequest } from "./api";
import type { SubmitRequestPayload } from "./api";

const edit = { department_id: "d", week_start: "2026-11-22", request_id: "q" } as unknown as SubmitRequestPayload;
const busy = { code: "P0001", message: "person_busy", details: JSON.stringify({ name: "Michal", rides: [] }) };
const guests = [{ request_id: "g", name: "Omer", kind: "cannot", warnings: [], reason: "day" }];
const guestQuestion = { code: "P0001", message: "host_edit_guests", details: JSON.stringify({ guests }) };
const sent = (call: number) => (supabaseRpc.mock.calls[call]![1] as { payload: Record<string, unknown> }).payload;

describe("submitRequest through the real rpc(): the overlap yes is reported back", () => {
  beforeEach(() => { supabaseRpc.mockReset(); registerPersonBusyAsker(() => Promise.resolve(true)); });

  it("tags the guest question that follows the confirmed call", async () => {
    supabaseRpc.mockResolvedValueOnce({ data: null, error: busy }).mockResolvedValueOnce({ data: null, error: guestQuestion });
    expect(await submitRequest(edit)).toMatchObject({ needs_confirmation: "host_guests", host_guests: guests, overlap_confirmed: true });
    expect(sent(0).overlap_confirmed).toBeUndefined();
    expect(sent(1).overlap_confirmed).toBe(true);
  });

  it("tags a plain success, and leaves a save that asked nothing alone", async () => {
    supabaseRpc.mockResolvedValueOnce({ data: null, error: busy }).mockResolvedValueOnce({ data: { request_id: "q", status: "assigned" }, error: null });
    expect(await submitRequest(edit)).toEqual({ request_id: "q", status: "assigned", overlap_confirmed: true });
    supabaseRpc.mockResolvedValueOnce({ data: { request_id: "q", status: "assigned" }, error: null });
    expect(await submitRequest(edit)).toEqual({ request_id: "q", status: "assigned" });
  });
});
