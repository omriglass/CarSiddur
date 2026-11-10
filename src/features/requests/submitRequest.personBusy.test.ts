import { beforeEach, describe, expect, it, vi } from "vitest";

import { he } from "@/i18n/he";
import { registerPersonBusyAsker } from "@/lib/personBusy";
import { AppError } from "@/lib/rpc";

const rpcMock = vi.fn();
vi.mock("@/lib/rpc", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/rpc")>()), rpc: (...args: unknown[]) => rpcMock(...args) }));

import { submitRequest } from "./api";
import type { SubmitRequestPayload } from "./api";

const payload = { department_id: "d", week_start: "2026-11-08", waitlist: true } as unknown as SubmitRequestPayload;
const refusal = () => new AppError("person_busy", he.errors.personBusy, undefined, JSON.stringify({ name: "Agata", rides: [] }));
const sentPayload = (call: number) => (rpcMock.mock.calls[call]![1] as { p_payload: Record<string, unknown> }).p_payload;

describe("submitRequest: entering the waiting list over one's own ride asks first (owner 2026-11-10)", () => {
  beforeEach(() => { rpcMock.mockReset(); registerPersonBusyAsker(null); });

  it("retries enter_waiting_list with overlap_confirmed after a yes", async () => {
    rpcMock.mockRejectedValueOnce(refusal()).mockResolvedValueOnce({ status: "waitlisted" });
    registerPersonBusyAsker(() => Promise.resolve(true));
    expect(await submitRequest(payload)).toEqual({ status: "waitlisted" });
    expect(rpcMock.mock.calls.map((call) => call[0])).toEqual(["enter_waiting_list", "enter_waiting_list"]);
    expect(sentPayload(0).overlap_confirmed).toBeUndefined();
    expect(sentPayload(1).overlap_confirmed).toBe(true);
  });

  it("a no sends nothing more and stays silent", async () => {
    rpcMock.mockRejectedValue(refusal());
    registerPersonBusyAsker(() => Promise.resolve(false));
    await expect(submitRequest(payload)).rejects.toMatchObject({ code: "person_busy", declined: true });
    expect(rpcMock).toHaveBeenCalledTimes(1);
  });
});
