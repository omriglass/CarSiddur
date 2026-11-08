import { describe, expect, it, vi } from "vitest";

import { he } from "@/i18n/he";

import { AppError } from "./rpc";
import { isNeedsLargeTrunk, parseSmallTrunkDetail, smallTrunkConfirmBody, smallTrunkConfirmTitle, withSmallTrunkConfirm } from "./smallTrunk";

const DETAIL = JSON.stringify({ request_ids: ["r1"], names: ["דנה"], car_id: "c1", car_name: "יונדאי 1" });
const refusal = () => new AppError("needs_large_trunk", he.errors.needsLargeTrunk, undefined, DETAIL);

describe("parseSmallTrunkDetail", () => {
  it("reads the server's JSON detail", () => {
    expect(parseSmallTrunkDetail(DETAIL)).toEqual({ requestIds: ["r1"], names: ["דנה"], carId: "c1", carName: "יונדאי 1", needs: [], towTakenBy: null });
  });
  it("falls back to an empty info for missing or broken detail", () => {
    const empty = { requestIds: [], names: [], carId: null, carName: null, needs: [], towTakenBy: null };
    expect(parseSmallTrunkDetail(undefined)).toEqual(empty);
    expect(parseSmallTrunkDetail("not json")).toEqual(empty);
    expect(parseSmallTrunkDetail('{"request_ids": 3}')).toEqual(empty);
  });
});

describe("smallTrunkConfirmBody", () => {
  it("names the requester and the car", () => {
    expect(smallTrunkConfirmBody(parseSmallTrunkDetail(DETAIL))).toBe("הבקשה של דנה צריכה תא מטען גדול, וליונדאי 1 אין. לשבץ בכל זאת?");
  });
  it("uses generic words and the plural form when the detail is empty or lists several requests", () => {
    expect(smallTrunkConfirmBody(parseSmallTrunkDetail(undefined))).toContain(he.smallTrunk.unknownName);
    const many = parseSmallTrunkDetail(JSON.stringify({ request_ids: ["a", "b"], names: ["דנה", "רן"], car_name: "ואן" }));
    expect(smallTrunkConfirmBody(many)).toContain("הבקשות של דנה, רן");
  });
});

describe("REQ §13.200: the towing wording follows the missing needs", () => {
  const detail = (extra: object) => parseSmallTrunkDetail(JSON.stringify({ request_ids: ["r1"], names: ["דנה"], car_id: "c1", car_name: "יונדאי 1", ...extra }));
  it("towing only: its own title and body", () => {
    const info = detail({ needs: ["tow_hitch"] });
    expect(smallTrunkConfirmTitle(info)).toBe("צריך רכב גורר");
    expect(smallTrunkConfirmBody(info)).toBe("הבקשה של דנה צריכה רכב גורר, ויונדאי 1 אינו רכב גורר. לשבץ בכל זאת?");
  });
  it("both needs: one question naming both", () => {
    const info = detail({ needs: ["large_trunk", "tow_hitch"] });
    expect(smallTrunkConfirmTitle(info)).toBe("צריך תא מטען גדול ורכב גורר");
    expect(smallTrunkConfirmBody(info)).toBe("הבקשה של דנה צריכה תא מטען גדול ורכב גורר, וליונדאי 1 אין תא מטען גדול והוא אינו רכב גורר. לשבץ בכל זאת?");
  });
  it("the hitch is taken: says for whom", () => {
    const info = detail({ needs: ["tow_hitch"], tow_taken_by: "רן" });
    expect(smallTrunkConfirmBody(info)).toBe("הבקשה של דנה צריכה רכב גורר, ויונדאי 1 כבר גורר עבור רן. לשבץ בכל זאת?");
  });
  it("large trunk only keeps the original copy", () => {
    const info = detail({ needs: ["large_trunk"] });
    expect(smallTrunkConfirmTitle(info)).toBe(he.smallTrunk.confirmTitle);
    expect(smallTrunkConfirmBody(info)).toBe("הבקשה של דנה צריכה תא מטען גדול, וליונדאי 1 אין. לשבץ בכל זאת?");
  });
});

describe("withSmallTrunkConfirm", () => {
  it("returns the first result when nothing is refused (no dialog)", async () => {
    const call = vi.fn().mockResolvedValue("ok");
    const confirm = vi.fn();
    expect(await withSmallTrunkConfirm(call, confirm)).toBe("ok");
    expect(call).toHaveBeenCalledTimes(1);
    expect(call).toHaveBeenCalledWith(false);
    expect(confirm).not.toHaveBeenCalled();
  });
  it("retries with allow_small_trunk after a yes", async () => {
    const call = vi.fn().mockRejectedValueOnce(refusal()).mockResolvedValueOnce("placed");
    const confirm = vi.fn().mockResolvedValue(true);
    expect(await withSmallTrunkConfirm(call, confirm)).toBe("placed");
    expect(call.mock.calls).toEqual([[false], [true]]);
    expect(confirm).toHaveBeenCalledWith({ requestIds: ["r1"], names: ["דנה"], carId: "c1", carName: "יונדאי 1", needs: [], towTakenBy: null });
  });
  it("does nothing more after a no", async () => {
    const call = vi.fn().mockRejectedValue(refusal());
    expect(await withSmallTrunkConfirm(call, vi.fn().mockResolvedValue(false))).toBeUndefined();
    expect(call).toHaveBeenCalledTimes(1);
  });
  it("lets every other error through, and a refusal of the retry too", async () => {
    const other = new AppError("not_authorized", "x");
    await expect(withSmallTrunkConfirm(vi.fn().mockRejectedValue(other), vi.fn())).rejects.toBe(other);
    const again = vi.fn().mockRejectedValue(refusal());
    await expect(withSmallTrunkConfirm(again, vi.fn().mockResolvedValue(true))).rejects.toBeInstanceOf(AppError);
    expect(again).toHaveBeenCalledTimes(2);
    expect(isNeedsLargeTrunk(refusal())).toBe(true);
    expect(isNeedsLargeTrunk(other)).toBe(false);
  });
});
