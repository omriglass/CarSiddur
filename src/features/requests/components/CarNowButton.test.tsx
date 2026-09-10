import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { he, tv } from "@/i18n/he";

import { CarNowButton } from "./CarNowButton";

const mocks = vi.hoisted(() => ({ useFreeCarsNowQuery: vi.fn() }));
vi.mock("../hooks", () => ({ useFreeCarsNowQuery: mocks.useFreeCarsNowQuery }));
// The sheet itself is covered by QuickRequestSheet.test.tsx / RequestForm.oneWaySync.test.tsx;
// this test only checks the button's own enabled/disabled rendering.
vi.mock("./QuickRequestSheet", () => ({ QuickRequestSheet: () => null }));

function baseResult(overrides: Partial<ReturnType<typeof mocks.useFreeCarsNowQuery>> = {}) {
  return {
    isLoading: false,
    weekStart: "2026-09-06",
    day: "2026-09-10",
    now: new Date("2026-09-10T10:00:00+03:00"),
    cars: [{ id: "car-1", name: "Car 1", type: "shared" }],
    freeCars: [],
    freeWindows: [],
    awayWindows: [],
    ...overrides,
  };
}

describe("CarNowButton", () => {
  it("is disabled with the no-car label when nothing is free right now", () => {
    mocks.useFreeCarsNowQuery.mockReturnValue(baseResult());
    render(<CarNowButton departmentId="department" />);
    expect(screen.getByText(he.quickRequest.noCarNow)).toBeVisible();
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });

  it("is enabled with the take-car-now label and subtitle when exactly one car is free", () => {
    mocks.useFreeCarsNowQuery.mockReturnValue(
      baseResult({ freeCars: [{ id: "car-1", name: "Car 1", type: "shared" }] }),
    );
    render(<CarNowButton departmentId="department" />);
    expect(screen.getByRole("button")).toBeVisible();
    expect(screen.getByText(he.quickRequest.takeCarNow)).toBeVisible();
    expect(screen.getByText(tv("quickRequest.homeCardSubtitle", { car: "Car 1" }))).toBeVisible();
  });

  it("stays disabled while loading even if a free car would otherwise show", () => {
    mocks.useFreeCarsNowQuery.mockReturnValue(
      baseResult({ isLoading: true, freeCars: [{ id: "car-1", name: "Car 1", type: "shared" }] }),
    );
    render(<CarNowButton departmentId="department" />);
    expect(screen.getByText(he.quickRequest.noCarNow)).toBeVisible();
  });
});
