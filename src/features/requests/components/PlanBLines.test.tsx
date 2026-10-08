import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { canEditRequest } from "../window";
import { PlanBLines } from "./PlanBLines";

vi.mock("@/features/fleet/hooks", () => ({
  useDestinations: () => ({ data: [{ id: "haifa", name: "חיפה" }] }),
}));

const alternative = {
  dropPlaceId: "harish",
  dropPlaceText: null,
  dropPlaceName: "צומת חריש",
  arriveBy: "2026-10-14T05:00:00Z",
  pickup: true,
  pickupAt: "2026-10-14T16:00:00Z", pickupPlaceId: null, pickupPlaceText: null, pickupPlaceName: null,
  originalMain: { trip_type: "round_trip", destination_id: "haifa", depart_at: "2026-10-14T05:00:00Z", return_at: "2026-10-14T16:00:00Z" },
};

describe("PlanBLines (/my)", () => {
  it("shows the plan B of a request that still waits", () => {
    render(<PlanBLines row={{ status: "waitlisted", departmentId: "d", fallback: "alternative", servedByAlternative: false, alternative }} />);
    expect(screen.getByTestId("request-plan-b")).toHaveTextContent("תוכנית ב׳: הקפצה לצומת חריש עד 08:00 · איסוף ב־19:00");
  });

  it("shows 'served by plan B' with the original request line", () => {
    render(<PlanBLines row={{ status: "assigned", departmentId: "d", fallback: "alternative", servedByAlternative: true, alternative }} />);
    expect(screen.getByTestId("request-served-by-plan-b")).toHaveTextContent("שובצת בתוכנית ב׳: הקפצה לצומת חריש עד 08:00, איסוף מצומת חריש 19:00");
    expect(screen.getByTestId("request-original-main")).toHaveTextContent("הבקשה המקורית: הלוך-חזור לחיפה ד׳ 14.10 08:00–19:00");
  });

  it("renders nothing without a fallback", () => {
    const { container } = render(<PlanBLines row={{ status: "submitted", departmentId: "d", fallback: "none", servedByAlternative: false, alternative: null }} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("a request served by its plan B cannot be edited", () => {
    expect(canEditRequest({ status: "assigned", servedByAlternative: true })).toBe(false);
  });
});
