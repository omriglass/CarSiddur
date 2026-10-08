import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { he } from "@/i18n/he";
import type { PublicationDay } from "../../api";
import { PublishScreen } from "./PublishScreen";

const mocks = vi.hoisted(() => ({ readiness: [] as PublicationDay[], publish: vi.fn() }));
vi.mock("../../hooks", () => ({
  usePublicationReadiness: () => ({ data: mocks.readiness, isLoading: false, isError: false, refetch: vi.fn() }),
  useWeekRequestsWithNames: () => ({ data: [], isLoading: false, isError: false }),
  useAllWeekRides: () => ({ data: [], isLoading: false, isError: false }),
  useProposalsForWeek: () => ({ data: [], isLoading: false, isError: false }),
  useSiddurVersions: () => ({ data: [], isLoading: false, isError: false }),
  usePublishSiddurMutation: () => ({ mutateAsync: mocks.publish, isPending: false }),
}));
vi.mock("@/features/siddur/components/RideChangeAnswers", () => ({ RideChangeAnswers: () => null }));
vi.mock("sonner", () => ({ toast: { success: vi.fn() } }));

const departmentId = "department";
const weekStart = "2026-09-13";
const days = Array.from({ length: 7 }, (_, index) => `2026-09-${13 + index}`);

function show() {
  return render(<MemoryRouter initialEntries={["/publish"]}>
    <Routes>
      <Route path="/publish" element={<PublishScreen departmentId={departmentId} weekStart={weekStart} />} />
      <Route path={`/sadran/${departmentId}/${weekStart}/board`} element={<p data-testid="returned-to-board">Board</p>} />
    </Routes>
  </MemoryRouter>);
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"], now: new Date("2026-09-12T08:00:00Z") });
  mocks.publish.mockReset().mockResolvedValue("published-version");
  mocks.readiness = days.map((day) => ({
    day, ready: true, published: false, requestCount: 1, unresolvedRequests: 0, incompleteAssignments: 0,
    pendingProposals: 0, draftProposals: 0, missingDriverRides: 0, conflictRides: 0,
  }));
});

afterEach(() => { vi.useRealTimers(); });

describe("publication choices", () => {
  it("'choose days' pre-ticks only ready, unpublished, non-past days (R7U2)", () => {
    mocks.readiness[2] = { ...mocks.readiness[2]!, ready: false, unresolvedRequests: 1 };
    mocks.readiness[3] = { ...mocks.readiness[3]!, published: true };
    show();
    fireEvent.click(screen.getByRole("button", { name: he.publicationFlow.selectDays }));
    // days 13..19; "today" is the 12th, so only 2 (not ready) and 3 (published) are excluded
    expect(screen.getAllByRole("checkbox", { checked: true })).toHaveLength(5);
  });

  it("refuses a day with unsent drafts and says why (REQ §13.94)", () => {
    mocks.readiness = mocks.readiness.map((day, index) => index === 2 ? { ...day, ready: false, draftProposals: 1 } : day);
    show();
    expect(screen.getByRole("button", { name: he.publicationFlow.allYes })).toBeDisabled();
    expect(screen.getByText(he.boardDrafts.publishBlockedDay)).toBeVisible();
    expect(mocks.publish).not.toHaveBeenCalled();
  });

  it("refuses a day with an unanswered plan-B proposal (REQ §13.112 a) and lists the day", () => {
    mocks.readiness = mocks.readiness.map((day, index) => index === 2 ? { ...day, ready: false, alternativeProposals: 1 } : day);
    show();
    expect(screen.getByRole("button", { name: he.publicationFlow.allYes })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: he.publicationFlow.selectDays }));
    expect(screen.getByText(he.sadranPlanB.publishDayOne)).toBeVisible();
    expect(mocks.publish).not.toHaveBeenCalled();
  });

  it("publishes all seven resolved days without an unanswered-items override", async () => {
    show();
    expect(screen.getByText(he.publicationFlow.allReady)).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: he.publicationFlow.allYes }));
    await waitFor(() => expect(mocks.publish).toHaveBeenCalledExactlyOnceWith({ departmentId, weekStart, days, allowUnanswered: false }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    await screen.findByTestId("returned-to-board");
  });

  it("selects only ready days, then publishes exactly that selection", async () => {
    mocks.readiness[1] = { ...mocks.readiness[1]!, ready: false, unresolvedRequests: 1 };
    mocks.readiness[3] = { ...mocks.readiness[3]!, ready: false, pendingProposals: 1 };
    const readyDays = days.filter((_, index) => index !== 1 && index !== 3);
    show();
    fireEvent.click(screen.getByRole("button", { name: he.publicationFlow.onlyReady }));
    expect(mocks.publish).not.toHaveBeenCalled();
    expect(screen.getAllByRole("checkbox", { checked: true })).toHaveLength(5);
    expect(screen.getAllByRole("checkbox", { checked: false })).toHaveLength(2);
    fireEvent.click(screen.getByRole("button", { name: he.publicationFlow.selectedPublish }));
    await waitFor(() => expect(mocks.publish).toHaveBeenCalledExactlyOnceWith({ departmentId, weekStart, days: readyDays, allowUnanswered: false }));
    await screen.findByTestId("returned-to-board");
  });

  it.each(["incompleteAssignments", "pendingProposals", "missingDriverRides"] as const)("requires explicit confirmation before publishing days with %s", async (field) => {
    mocks.readiness[2] = { ...mocks.readiness[2]!, ready: false, [field]: 1 };
    show();
    fireEvent.click(screen.getByRole("button", { name: he.publicationFlow.allYes }));
    expect(mocks.publish).not.toHaveBeenCalled();
    const dialog = screen.getByRole("dialog");
    expect(within(dialog).getByText(he.publicationFlow.unresolvedHelp)).toBeVisible();
    fireEvent.click(within(dialog).getByRole("button", { name: he.common.cancel }));
    expect(mocks.publish).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: he.publicationFlow.allYes }));
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: he.publicationFlow.confirmUnresolved }));
    await waitFor(() => expect(mocks.publish).toHaveBeenCalledExactlyOnceWith({ departmentId, weekStart, days, allowUnanswered: true }));
    await screen.findByTestId("returned-to-board");
  });

  it("does not allow a schedule conflict to use the unanswered-items override", () => {
    mocks.readiness[2] = { ...mocks.readiness[2]!, ready: false, conflictRides: 1 };
    show();
    expect(screen.getByRole("button", { name: he.publicationFlow.allYes })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: he.publicationFlow.selectDays }));
    // the conflicted day is neither pre-ticked nor tickable
    const boxes = screen.getAllByRole("checkbox");
    expect(boxes[2]).not.toBeChecked();
    expect(boxes[2]).toBeDisabled();
    expect(mocks.publish).not.toHaveBeenCalled();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("does not block publication on unresolvedRequests alone, but shows the info note (REQ §13.75)", async () => {
    mocks.readiness[1] = { ...mocks.readiness[1]!, unresolvedRequests: 2 };
    show();
    expect(screen.getByText(he.sadranPublish.unresolvedWillBeGrouped)).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: he.publicationFlow.allYes }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    await waitFor(() => expect(mocks.publish).toHaveBeenCalledExactlyOnceWith({ departmentId, weekStart, days, allowUnanswered: false }));
  });
});
