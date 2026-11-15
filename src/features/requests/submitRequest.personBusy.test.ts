import { beforeEach, describe, expect, it, vi } from "vitest";

import { he } from "@/i18n/he";
import { registerPersonBusyAsker } from "@/lib/personBusy";
import { AppError } from "@/lib/rpc";
import { registerShortTurnaroundAsker } from "@/lib/shortTurnaround";

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
    expect(sentPayload(0).short_turnaround_ask).toBe(true);
  });

  it("a no sends nothing more and stays silent", async () => {
    rpcMock.mockRejectedValue(refusal());
    registerPersonBusyAsker(() => Promise.resolve(false));
    await expect(submitRequest(payload)).rejects.toMatchObject({ code: "person_busy", declined: true });
    expect(rpcMock).toHaveBeenCalledTimes(1);
  });
});

describe("submitRequest: a waiting-list entry the car's next ride is too close to asks (REQ §13.190, owner 2026-11-10)", () => {
  beforeEach(() => { rpcMock.mockReset(); registerShortTurnaroundAsker(null); });
  const left = { request_id: "q", status: "waitlisted", short_turnaround: { at: "12:00", gap: 15, name: "Noa", ride_id: "r" } };

  it("a yes settles it through answer_short_turnaround and returns the placement", async () => {
    rpcMock.mockResolvedValueOnce(left).mockResolvedValueOnce({ status: "assigned", ride_id: "r2" });
    registerShortTurnaroundAsker(() => Promise.resolve(true));
    expect(await submitRequest(payload)).toMatchObject({ status: "assigned", ride_id: "r2", request_id: "q" });
    expect(rpcMock.mock.calls[1]).toEqual(["answer_short_turnaround", { p_request_id: "q", p_accept: true }]);
  });

  it("a no leaves it on the waiting list (answered, so the Sadran hears of it)", async () => {
    rpcMock.mockResolvedValueOnce(left).mockResolvedValueOnce({ status: "waitlisted" });
    registerShortTurnaroundAsker(() => Promise.resolve(false));
    expect(await submitRequest(payload)).toMatchObject({ status: "waitlisted" });
    expect(rpcMock.mock.calls[1]).toEqual(["answer_short_turnaround", { p_request_id: "q", p_accept: false }]);
  });
});

describe("submitRequest: a yes to the overlap question is reported back, so the form never asks it twice (R21B7)", () => {
  beforeEach(() => { rpcMock.mockReset(); registerPersonBusyAsker(null); });
  const edit = { department_id: "d", week_start: "2026-11-08", request_id: "q" } as unknown as SubmitRequestPayload;

  it("tags the result, also when the confirmed call ends in the guest question", async () => {
    registerPersonBusyAsker(() => Promise.resolve(true));
    rpcMock.mockRejectedValueOnce(refusal()).mockResolvedValueOnce({ request_id: "q", status: "assigned" });
    expect(await submitRequest(edit)).toEqual({ request_id: "q", status: "assigned", overlap_confirmed: true });

    const guests = [{ request_id: "g", name: "Noa", kind: "cannot", warnings: [], reason: "day" }];
    rpcMock.mockRejectedValueOnce(refusal())
      .mockRejectedValueOnce(new AppError("host_edit_guests", "", undefined, JSON.stringify({ guests })));
    expect(await submitRequest(edit)).toMatchObject({ needs_confirmation: "host_guests", host_guests: guests, overlap_confirmed: true });
  });

  it("leaves a result alone when nothing was asked", async () => {
    rpcMock.mockResolvedValueOnce({ request_id: "q", status: "assigned" });
    expect(await submitRequest(edit)).toEqual({ request_id: "q", status: "assigned" });
  });
});
