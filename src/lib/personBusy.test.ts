import { describe, expect, it, vi } from "vitest";

import { he } from "@/i18n/he";

import { parsePersonBusyDetail, personBusyBody, withPersonBusyRetry } from "./personBusy";
import { AppError } from "./rpc";
import { formatTime } from "./time";

const RIDE = { ride_id: "g", driver_name: "גלפי", is_driver: false, starts_at: "2026-11-02T13:10:00Z", ends_at: "2026-11-02T15:45:00Z" };
const DETAIL = JSON.stringify({ person_id: "agata", name: "אגתה", rides: [RIDE] });
const refusal = () => new AppError("person_busy", he.errors.personBusy, undefined, DETAIL);
const times = `${formatTime(new Date(RIDE.starts_at))}–${formatTime(new Date(RIDE.ends_at))}`;

describe("parsePersonBusyDetail (REQ §13.176)", () => {
  it("reads the person and their own part of each overlapping ride", () => {
    expect(parsePersonBusyDetail(DETAIL)).toEqual({ personId: "agata", name: "אגתה",
      rides: [{ rideId: "g", driverName: "גלפי", isDriver: false, startsAt: RIDE.starts_at, endsAt: RIDE.ends_at }] });
  });
  it("falls back to an empty info for missing or broken detail", () => {
    const empty = { personId: null, name: "", rides: [] };
    expect(parsePersonBusyDetail(undefined)).toEqual(empty);
    expect(parsePersonBusyDetail("not json")).toEqual(empty);
    expect(parsePersonBusyDetail('{"rides": 3}')).toEqual(empty);
  });
});

describe("personBusyBody", () => {
  it("says 'you' to the person themselves and names them to anyone else", () => {
    const info = parsePersonBusyDetail(DETAIL);
    expect(personBusyBody(info, "agata")).toBe(`יש לך כבר נסיעה בשעות האלה: עם גלפי ${times}. להמשיך בכל זאת?`);
    expect(personBusyBody(info, "sadran")).toBe(`אגתה כבר בנסיעה בשעות האלה: עם גלפי ${times}. להמשיך בכל זאת?`);
  });
  it("says 'drives' for a ride they drive, and stays generic without rides", () => {
    const driving = parsePersonBusyDetail(JSON.stringify({ person_id: "agata", name: "אגתה", rides: [{ ...RIDE, is_driver: true }] }));
    expect(personBusyBody(driving, "agata")).toContain("נוהג/ת");
    expect(personBusyBody(parsePersonBusyDetail(JSON.stringify({ person_id: "agata", name: "אגתה" })), "agata")).toBe(he.personBusy.bodySelf);
    expect(personBusyBody(parsePersonBusyDetail(undefined), "x")).toContain(he.personBusy.unknownName);
  });
});

describe("withPersonBusyRetry", () => {
  it("asks on person_busy and repeats the call with the allow flag on a yes", async () => {
    const call = vi.fn(async (allow: boolean) => { if (!allow) throw refusal(); return "done"; });
    const ask = vi.fn(async () => true);
    await expect(withPersonBusyRetry(call, ask)).resolves.toBe("done");
    expect(call.mock.calls.map(([allow]) => allow)).toEqual([false, true]);
    expect(ask).toHaveBeenCalledWith(expect.objectContaining({ personId: "agata" }));
  });
  it("on a no, rejects with the refusal marked declined (no toast) and does not repeat", async () => {
    const call = vi.fn(async () => { throw refusal(); });
    const error = await withPersonBusyRetry(call, async () => false).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(AppError);
    expect((error as AppError).declined).toBe(true);
    expect(call).toHaveBeenCalledTimes(1);
  });
  it("lets any other error through untouched", async () => {
    const other = new AppError("stale_version", "x");
    const ask = vi.fn(async () => true);
    await expect(withPersonBusyRetry(async () => { throw other; }, ask)).rejects.toBe(other);
    expect(ask).not.toHaveBeenCalled();
  });
});
