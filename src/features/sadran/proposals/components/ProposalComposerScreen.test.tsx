import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";

import { he, t } from "@/i18n/he";

// `origin` (REQ §13.93, ORIGINS_PLAN §3/§4 "O4b"): the composer never edits a `changeOrigin`
// suggestion's car/place -- it only shows and sends what the board already prefilled, so this
// suite mocks every data hook with a fixed, deterministic payload instead of a real board/week.

vi.mock("@/features/fleet/hooks", () => ({
  useCars: () => ({ data: [{ id: "car-1", name: "רכב 1" }] }),
  useDestinations: () => ({ data: [{ id: "dest-haifa", name: "חיפה", travel_minutes: 40 }] }),
}));

vi.mock("@/features/auth/useProfile", () => ({
  useProfile: () => ({ data: { id: "sadran-1", full_name: "דנה הסדרנית" } }),
}));

vi.mock("@/features/auth/useActiveDepartment", () => ({
  useActiveDepartment: () => ({ departments: [] }),
}));

vi.mock("@/features/siddur/api", () => ({ fetchBoardRideById: vi.fn() }));

const createMutateAsync = vi.fn().mockResolvedValue("draft-1");

vi.mock("../../hooks", async () => {
  const actual = await vi.importActual<typeof import("../../hooks")>("../../hooks");
  return {
    ...actual,
    useWeekRequestsWithNames: () => ({
      data: [{
        id: "req-1",
        requester_id: "member-1",
        requester_full_name: "יוסי",
        destination_id: "dest-work",
        destination_text: null,
        ride_type_name_he: "עבודה",
        depart_at: "2041-02-03T06:00:00Z",
        return_at: "2041-02-03T10:00:00Z",
        trip_shape: "round_trip",
        origin_resolved_name: "הבית",
      }],
    }),
    useWhatsappTemplates: () => ({
      data: [{
        variant: "origin",
        body: "היי {{firstName}}, אין רכב פנוי מ{{origin}}, אבל יש רכב פנוי מ{{newOrigin}} ({{car}}). {{link}}",
      }],
    }),
    useProposalsForWeek: () => ({ data: [], isSuccess: true, isFetching: false }),
    useProposalParties: () => ({ data: [] }),
    useProfilesByIds: () => ({ data: [{ id: "member-1", full_name: "יוסי", phone: null }] }),
    useCreateProposalMutation: () => ({ mutateAsync: createMutateAsync, isPending: false }),
    useSendProposalMutation: () => ({ mutateAsync: vi.fn().mockResolvedValue({ party_tokens: {} }), isPending: false }),
    useRecordAnswerOnBehalfMutation: () => ({ mutate: vi.fn() }),
    useApplyProposalMutation: () => ({ mutate: vi.fn(), isPending: false }),
  };
});

const { ProposalComposerScreen } = await import("./ProposalComposerScreen");

function renderComposer() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const prefill = {
    requestId: "req-1",
    rideId: null,
    type: "origin" as const,
    payload: { origin_id: "dest-haifa", car_id: "car-1" },
    returnTo: "/sadran/dept-1/2041-02-02/board",
  };
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[{ pathname: "/sadran/dept-1/2041-02-02/proposals/new", state: prefill }]}>
        <Routes>
          <Route path="/sadran/:dept/:week/proposals/new" element={<ProposalComposerScreen departmentId="dept-1" weekStart="2041-02-02" />} />
          <Route path="/sadran/:dept/:week/board" element={<p>board</p>} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe("ProposalComposerScreen — origin type", () => {
  it("shows a one-line summary of the origin change and renders the WhatsApp preview with resolved names (no raw {{..}})", () => {
    renderComposer();
    expect(screen.getByText("יציאה מחיפה במקום מהבית, ברכב רכב 1")).toBeInTheDocument();
    const textarea = document.querySelector("textarea") as HTMLTextAreaElement;
    expect(textarea.value).toContain("אין רכב פנוי מהבית");
    expect(textarea.value).toContain("יש רכב פנוי מחיפה (רכב 1)");
    // `{{link}}` deliberately survives until send time (per-recipient token); every other
    // placeholder must already be resolved.
    expect(textarea.value.replace("{{link}}", "")).not.toMatch(/\{\{\w+\}\}/);
  });

  it("sends the prefilled { origin_id, car_id } payload unchanged on propose", () => {
    renderComposer();
    fireEvent.click(screen.getByRole("button", { name: t("action.propose") }));
    expect(createMutateAsync).toHaveBeenCalledWith(expect.objectContaining({
      requestId: "req-1",
      rideId: null,
      type: "origin",
      payload: { origin_id: "dest-haifa", car_id: "car-1" },
    }));
  });

  it("labels the type selector with the origin proposal's Hebrew name", () => {
    renderComposer();
    expect(screen.getByText(he.proposal.type.origin)).toBeInTheDocument();
  });
});
