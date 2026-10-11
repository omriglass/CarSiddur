import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { he } from "@/i18n/he";

import { TripTypeChange } from "./TripTypeChange";

vi.mock("../../hooks", () => ({ useSetRequestTripTypeMutation: () => ({ mutate: vi.fn(), isPending: false, isSuccess: false }) }));

const base = { requestId: "r", version: 1, name: "Dana", departmentId: "d", weekStart: "2044-01-03" };

describe("TripTypeChange current-state label (REQ §13.126 g)", () => {
  it("reads a kept-car request as a round trip with the note, never הקפצה", () => {
    render(<TripTypeChange {...base} tripType="drop_off" keepCarAtDestination destination="Haifa" />);
    const trigger = screen.getByTestId("trip-type-select");
    expect(trigger).toHaveTextContent(he.request.tripTypeRoundTrip);
    expect(trigger).toHaveTextContent("Haifa");
    expect(trigger).not.toHaveTextContent(he.request.tripTypeDropOff);
  });
  it("a plain הקפצה keeps its label", () => {
    render(<TripTypeChange {...base} tripType="drop_off" />);
    expect(screen.getByTestId("trip-type-select")).toHaveTextContent(he.request.tripTypeDropOff);
  });
});
