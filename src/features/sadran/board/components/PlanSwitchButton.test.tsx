import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { he } from "@/i18n/he";

import { PlanSwitchButton, type PlanSwitchRequest } from "./PlanSwitchButton";

const mutate = vi.fn();
let weekRow: { phase: string; published_days: string[] } = { phase: "open", published_days: [] };
vi.mock("../../hooks", () => ({
  useSwitchRequestPlanMutation: () => ({ mutate, isPending: false }),
  useWeekRow: () => ({ data: weekRow }),
}));

const alternative = { drop_place_id: null, drop_place_text: "Hadera", arrive_by: "2044-01-04T06:00:00Z", pickup: false, pickup_at: null, applied_at: null };
const request: PlanSwitchRequest = { id: "r1", version: 3, fallback: "alternative", alternative, served_by_alternative: false, depart_at: "2044-01-04T05:00:00Z" };
const base = { name: "Dana", departmentId: "d", weekStart: "2044-01-02" };

beforeEach(() => { mutate.mockClear(); weekRow = { phase: "open", published_days: [] }; });

describe("PlanSwitchButton", () => {
  it("offers plan B when not served by it, and confirms with to=alternative", () => {
    render(<PlanSwitchButton request={request} {...base} />);
    fireEvent.click(screen.getByRole("button", { name: he.planSwitch.toAlternative }));
    expect(screen.getByText(new RegExp(he.planSwitch.silent))).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: he.planSwitch.confirm }));
    expect(mutate.mock.calls[0]?.[0]).toMatchObject({ requestId: "r1", to: "alternative", expectedVersion: 3 });
  });
  it("offers plan A when served by plan B, and confirms with to=main", () => {
    render(<PlanSwitchButton request={{ ...request, served_by_alternative: true }} {...base} />);
    fireEvent.click(screen.getByRole("button", { name: he.planSwitch.toMain }));
    fireEvent.click(screen.getByRole("button", { name: he.planSwitch.confirm }));
    expect(mutate.mock.calls[0]?.[0]).toMatchObject({ to: "main" });
  });
  it("a published week whose day is not published yet switches silently (SQL is_day_public)", () => {
    weekRow = { phase: "published", published_days: ["2044-01-05"] };
    render(<PlanSwitchButton request={request} {...base} />);
    fireEvent.click(screen.getByTestId("plan-switch"));
    expect(screen.getByText(new RegExp(he.planSwitch.silent))).toBeInTheDocument();
  });
  it("mentions the notice on a published day", () => {
    weekRow = { phase: "published", published_days: ["2044-01-04"] };
    render(<PlanSwitchButton request={request} {...base} />);
    fireEvent.click(screen.getByTestId("plan-switch"));
    expect(screen.getByText(new RegExp("Dana .*" + he.planSwitch.notified.split("}} ")[1]))).toBeInTheDocument();
    expect(screen.queryByText(new RegExp(he.planSwitch.silent))).toBeNull();
  });
  it.each([
    ["no plan B", { alternative: null }],
    ["manage fallback", { fallback: "manage" }],
    ["a series", { series_id: "s" }],
    ["the pickup sibling", { plan_b_parent_id: "p" }],
  ])("is hidden for %s", (_label, patch) => {
    render(<PlanSwitchButton request={{ ...request, ...patch }} {...base} />);
    expect(screen.queryByTestId("plan-switch")).toBeNull();
  });
});
