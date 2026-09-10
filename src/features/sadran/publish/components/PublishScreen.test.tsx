import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { he } from "@/i18n/he";
import type { PublicationDay } from "../../api";
import { PublishScreen } from "./PublishScreen";

const mocks = vi.hoisted(() => ({ readiness: [] as PublicationDay[], publish: vi.fn() }));
vi.mock("../../hooks", () => ({
  usePublicationReadiness: () => ({ data: mocks.readiness, isLoading: false, isError: false, refetch: vi.fn() }),
  useWeekRequestsWithNames: () => ({ data: [], isLoading: false, isError: false }),
  useAllWeekRides: () => ({ data: [], isLoading: false, isError: false }),
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
  mocks.publish.mockReset().mockResolvedValue("published-version");
  mocks.readiness = days.map((day) => ({
    day, ready: true, published: false, requestCount: 1, unresolvedRequests: 0, incompleteAssignments: 0,
    pendingProposals: 0, missingDriverRides: 0, conflictRides: 0,
  }));
});

describe("publication choices", () => {
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
    expect(screen.getByRole("button", { name: he.publicationFlow.selectedPublish })).toBeDisabled();
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
