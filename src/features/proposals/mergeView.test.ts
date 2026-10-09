import { describe, expect, it } from "vitest";

import { mergePageModel } from "./mergeView";

import type { ProposalMergeView } from "./api";

const base: ProposalMergeView = {
  role: "host", guestName: "נטע", driverName: "נועה", leg: "out",
  rideStartsAt: "2026-10-12T09:00:00Z", rideEndsAt: "2026-10-12T12:00:00Z",
  newStartsAt: "2026-10-12T08:45:00Z", newEndsAt: "2026-10-12T12:00:00Z",
  guestDepartAt: "2026-10-12T08:45:00Z", guestReturnAt: null,
  ownDepartAt: "2026-10-12T08:45:00Z", ownReturnAt: null,
};

describe("mergePageModel", () => {
  it("shows a host the guest's request and the ride window, with no return for a one-way join", () => {
    const model = mergePageModel({ type: "merge", merge: base, request: null });
    expect(model?.heading).toBe("guest");
    expect(model?.trip).toEqual({ departAt: base.guestDepartAt, returnAt: null });
    expect(model?.before.departAt).toBe(base.rideStartsAt);
    expect(model?.after.departAt).toBe(base.newStartsAt);
    expect(model?.rideWindow).toBe(true);
  });
  it("shows the guest their own legs only", () => {
    const model = mergePageModel({ type: "merge", merge: { ...base, role: "guest" }, request: null });
    expect(model?.heading).toBe("own");
    expect(model?.trip.returnAt).toBeNull();
    expect(model?.rideWindow).toBe(false);
  });
  it("is null for other types or without the server block", () => {
    expect(mergePageModel({ type: "shift", merge: base, request: null })).toBeNull();
    expect(mergePageModel({ type: "merge", request: null })).toBeNull();
  });
  it("R12B7: the guest sees the host's name and the time that moves", () => {
    const model = mergePageModel({ type: "merge", merge: { ...base, role: "guest", ownDepartAt: "2026-10-12T09:30:00Z", guestDepartAt: "2026-10-12T08:45:00Z" }, request: null });
    expect(model?.hostName).toBe("נועה");
    expect(model?.change).toEqual({ kind: "depart", from: "2026-10-12T09:30:00Z", to: "2026-10-12T08:45:00Z" });
    expect(mergePageModel({ type: "merge", merge: { ...base, role: "guest" }, request: null })?.change).toBeNull();
  });
});
