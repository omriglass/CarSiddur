import { fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { he } from "@/i18n/he";

import type { TemplateSuggestion } from "../api";
import { TemplateSuggestions } from "./TemplateSuggestions";

const mocks = vi.hoisted(() => ({
  suggestions: vi.fn(),
  snooze: vi.fn(),
  stop: vi.fn(),
}));
vi.mock("../hooks", () => ({
  useTemplateSuggestionsQuery: () => mocks.suggestions(),
  useSnoozeTemplateMutation: () => ({ mutate: mocks.snooze, isPending: false }),
  useStopTemplateMutation: () => ({ mutate: mocks.stop, isPending: false }),
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn() } }));

function row(overrides: Partial<TemplateSuggestion> = {}): TemplateSuggestion {
  return {
    templateId: "template-1",
    departmentId: "dept-1",
    weekStart: "2027-01-10",
    destinationId: "dest-1",
    destinationText: null,
    destinationName: "עפולה",
    rideTypeId: "ride-type-1",
    rideTypeName: "אחר",
    tripShape: "round_trip",
    departDow: 2,
    departTime: "08:00:00",
    returnDow: 2,
    returnTime: "12:00:00",
    departAt: "2027-01-12T06:00:00+00:00",
    returnAt: "2027-01-12T10:00:00+00:00",
    oneWayCarMode: null,
    needsCarAtDestination: true,
    adults: 1,
    childSeats: 0,
    boosters: 0,
    childIds: [],
    companionIds: [],
    hasLuggage: false,
    flexDepartEarly: "00:00:00",
    flexDepartLate: "00:00:00",
    flexReturnEarly: "00:00:00",
    flexReturnLate: "00:00:00",
    preferredCarId: null,
    rideDescription: null,
    guestPassengerNames: [],
    notes: null,
    ...overrides,
  };
}

function show(rows: TemplateSuggestion[], weekStart?: string) {
  mocks.suggestions.mockReturnValue({ data: rows });
  return render(
    <MemoryRouter>
      <TemplateSuggestions weekStart={weekStart} />
    </MemoryRouter>,
  );
}

beforeEach(() => {
  mocks.suggestions.mockReset();
  mocks.snooze.mockReset();
  mocks.stop.mockReset();
});

describe("TemplateSuggestions", () => {
  it("renders nothing when there are no suggestions", () => {
    show([]);
    expect(screen.queryByTestId("template-suggestions")).not.toBeInTheDocument();
  });

  it("renders one card per suggestion with the destination and ride type", () => {
    show([row()]);
    expect(screen.getByText(he.request.suggestionsTitle)).toBeVisible();
    expect(screen.getByText("עפולה")).toBeVisible();
  });

  it("links the primary action to the prefilled new-request route, pinned to the suggestion's own week", () => {
    show([row()]);
    const link = screen.getByRole("link", { name: he.request.useSuggestion });
    expect(link).toHaveAttribute("href", "/requests/new?week=2027-01-10&template=template-1");
  });

  it("calls the snooze mutation with the row's template and week", () => {
    show([row()]);
    fireEvent.click(screen.getByRole("button", { name: he.request.snoozeSuggestion }));
    expect(mocks.snooze).toHaveBeenCalledWith(
      { templateId: "template-1", weekStart: "2027-01-10" },
      expect.objectContaining({ onSuccess: expect.any(Function) }),
    );
  });

  it("stops a template only after confirming the dialog", () => {
    show([row()]);
    fireEvent.click(screen.getByRole("button", { name: he.request.stopSuggestion }));
    expect(mocks.stop).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: he.common.confirm }));
    expect(mocks.stop).toHaveBeenCalledWith("template-1", expect.objectContaining({ onSuccess: expect.any(Function) }));
  });

  it("filters to a single week when weekStart is given", () => {
    show([row({ templateId: "t1", weekStart: "2027-01-10" }), row({ templateId: "t2", weekStart: "2027-01-17" })], "2027-01-17");
    expect(screen.getAllByRole("link", { name: he.request.useSuggestion })).toHaveLength(1);
  });
});
