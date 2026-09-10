import { beforeEach, describe, expect, it, vi } from "vitest";

import { tv } from "@/i18n/he";

const mocks = vi.hoisted(() => ({ toast: vi.fn(), success: vi.fn() }));
vi.mock("sonner", () => ({ toast: Object.assign(mocks.toast, { success: mocks.success }) }));

import { toastSeriesSubmitOutcome, toastSubmitOutcome } from "./submitOutcome";
import type { SubmitRequestResult, SubmitSeriesRequestResult } from "./api";
import { t } from "@/i18n/he";

beforeEach(() => {
  mocks.toast.mockClear();
  mocks.success.mockClear();
});

const CAR_NAME = (id: string | null | undefined) => (id === "car" ? "Car" : id === "preferred" ? "Preferred" : "");

function ctx(overrides: Partial<Parameters<typeof toastSubmitOutcome>[1]> = {}) {
  return { carName: CAR_NAME, ...overrides };
}

describe("toastSubmitOutcome", () => {
  it("stays silent for a plain weekly submission with no resolved outcome", () => {
    toastSubmitOutcome({ request_id: "r", is_late: false, warnings: [] }, ctx());
    expect(mocks.toast).not.toHaveBeenCalled();
    expect(mocks.success).not.toHaveBeenCalled();
  });

  it("stays silent for a null/undefined result", () => {
    toastSubmitOutcome(null, ctx());
    toastSubmitOutcome(undefined, ctx());
    expect(mocks.toast).not.toHaveBeenCalled();
    expect(mocks.success).not.toHaveBeenCalled();
  });

  it("shows the car-was-free toast before falling into the generic assigned branch", () => {
    const result: SubmitRequestResult = { request_id: "r", is_late: false, warnings: [], status: "assigned", car_id: "car", car_was_free: true };
    toastSubmitOutcome(result, ctx());
    expect(mocks.success).toHaveBeenCalledWith(tv("quickRequest.successCarWasFree", { car: "Car" }));
    expect(mocks.success).toHaveBeenCalledTimes(1);
  });

  it("shows the needs-driver toast for a one-way reservation awaiting a volunteer driver", () => {
    const result: SubmitRequestResult = { request_id: "r", is_late: false, warnings: [], needs_driver: true, ride_id: "ride", car_id: "car" };
    toastSubmitOutcome(result, ctx());
    expect(mocks.success).toHaveBeenCalledWith(tv("quickRequest.successNeedsDriver", { car: "Car" }));
  });

  it("shows the plain assigned toast when placed on the preferred car", () => {
    const result: SubmitRequestResult = { request_id: "r", is_late: false, warnings: [], status: "assigned", car_id: "car" };
    toastSubmitOutcome(result, ctx({ preferredCarId: "car", departTime: "08:00", returnTime: "12:00" }));
    expect(mocks.success).toHaveBeenCalledWith(tv("quickRequest.successAssigned", { car: "Car", start: "08:00", end: "12:00" }));
  });

  it("shows the fallback-car toast when placed on a different car than requested", () => {
    const result: SubmitRequestResult = { request_id: "r", is_late: false, warnings: [], status: "assigned", car_id: "car" };
    toastSubmitOutcome(result, ctx({ preferredCarId: "preferred" }));
    expect(mocks.success).toHaveBeenCalledWith(tv("quickRequest.successFallback", { car: "Car", preferredCar: "Preferred" }));
  });

  it("shows the waitlisted toast with a view-requests action", () => {
    const onViewRequests = vi.fn();
    const result: SubmitRequestResult = { request_id: "r", is_late: false, warnings: [], status: "waitlisted" };
    toastSubmitOutcome(result, ctx({ onViewRequests }));
    expect(mocks.toast).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ action: expect.objectContaining({ onClick: onViewRequests }) }),
    );
  });
});

describe("toastSeriesSubmitOutcome", () => {
  it("stays silent for a plain series submission with no resolved outcome", () => {
    toastSeriesSubmitOutcome({ series_id: "s", request_ids: ["a", "b"], warnings: [] });
    expect(mocks.toast).not.toHaveBeenCalled();
    expect(mocks.success).not.toHaveBeenCalled();
  });

  it("stays silent for a null/undefined result", () => {
    toastSeriesSubmitOutcome(null);
    toastSeriesSubmitOutcome(undefined);
    expect(mocks.toast).not.toHaveBeenCalled();
    expect(mocks.success).not.toHaveBeenCalled();
  });

  it("shows the series-assigned toast once a car took the whole span", () => {
    const result: SubmitSeriesRequestResult = { series_id: "s", request_ids: ["a", "b"], warnings: [], status: "assigned", reason: "SERIES_PLACED", car_id: "car" };
    toastSeriesSubmitOutcome(result);
    expect(mocks.success).toHaveBeenCalledWith(t("request.seriesAssigned"));
  });

  it("shows the series-waitlisted toast when no car could take the whole span", () => {
    const result: SubmitSeriesRequestResult = { series_id: "s", request_ids: ["a", "b"], warnings: [], status: "waitlisted", reason: "WAITLISTED_SERIES_NO_CAR" };
    toastSeriesSubmitOutcome(result);
    expect(mocks.toast).toHaveBeenCalledWith(t("request.seriesWaitlisted"));
  });
});
