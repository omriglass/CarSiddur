import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import { he } from "@/i18n/he";

// Sidesteps the real `SessionProvider` (which talks to the Supabase client) —
// this page must work with *no* session (ARCHITECTURE §8), so the default
// mock returns none.
vi.mock("@/features/auth/useSession", () => ({ useSession: () => ({ session: null, isLoading: false }) }));

const fetchProposalSummaryMock = vi.fn();
vi.mock("@/features/proposals/api", async () => {
  const actual = await vi.importActual<typeof import("@/features/proposals/api")>("@/features/proposals/api");
  return {
    ...actual,
    fetchProposalSummary: (...args: unknown[]) => fetchProposalSummaryMock(...args),
  };
});

const { ProposalFetchError } = await import("@/features/proposals/api");
const { ProposalTokenPage } = await import("./ProposalTokenPage");

function renderPage(token = "tok123") {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[`/p/${token}`]}>
        <Routes>
          <Route path="/p/:token" element={<ProposalTokenPage />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe("ProposalTokenPage", () => {
  it("shows the combined booking window before a merge party consents", async () => {
    fetchProposalSummaryMock.mockResolvedValueOnce({
      proposalId: "combined", type: "merge", status: "sent", reasonHe: "Combined trip", expiresAt: new Date(Date.now() + 3600_000).toISOString(),
      payload: { starts_at: "2041-01-13T07:00:00+02:00", ends_at: "2041-01-13T10:00:00+02:00" },
      request: { id: "passenger", destination: "Train", departAt: "2041-01-13T07:00:00+02:00", returnAt: null }, parties: [],
    });
    renderPage();
    await waitFor(() => expect(screen.getByText(he.rideCoordination.combinedWindow)).toBeInTheDocument());
    expect(screen.getByText("07:00 → 10:00")).toBeInTheDocument();
    expect(screen.getByText(he.rideCoordination.combinedConsent)).toBeInTheDocument();
  });
  it("shows the not-found copy for an invalid token (edge function 404)", async () => {
    fetchProposalSummaryMock.mockRejectedValueOnce(new ProposalFetchError("invalid_token"));
    renderPage();
    await waitFor(() => expect(screen.getByText("הקישור אינו תקין")).toBeInTheDocument());
  });

  it("shows the expired copy (edge function 410)", async () => {
    fetchProposalSummaryMock.mockRejectedValueOnce(new ProposalFetchError("expired"));
    renderPage();
    await waitFor(() => expect(screen.getByText("ההצעה פקעה — הבקשה חזרה למצב הקודם")).toBeInTheDocument());
  });

  it("shows accept/decline/suggest-other-time for a sent shift proposal", async () => {
    fetchProposalSummaryMock.mockResolvedValueOnce({
      proposalId: "p1",
      type: "shift",
      status: "sent",
      reasonHe: "בשעה 09:00 כל הרכבים תפוסים",
      expiresAt: new Date(Date.now() + 3600_000).toISOString(),
      payload: {},
      request: {
        id: "r1",
        destination: "עפולה",
        rideType: "בריאות",
        departAt: new Date().toISOString(),
        returnAt: new Date().toISOString(),
        adults: 1,
        childSeats: 0,
        boosters: 0,
      },
      parties: [],
    });
    renderPage();
    await waitFor(() => expect(screen.getByText("מקבל/ת את ההצעה")).toBeInTheDocument());
    expect(screen.getByText("לא מתאים לי")).toBeInTheDocument();
    expect(screen.getByText("להציע שעה אחרת")).toBeInTheDocument();
  });

  it("shows the deny variant without an accept-proposal button", async () => {
    fetchProposalSummaryMock.mockResolvedValueOnce({
      proposalId: "p2",
      type: "deny",
      status: "sent",
      reasonHe: "כל הרכבים תפוסים בשעות אלה",
      expiresAt: new Date(Date.now() + 3600_000).toISOString(),
      payload: {},
      request: null,
      parties: [],
    });
    renderPage();
    await waitFor(() => expect(screen.getByText("הבנתי")).toBeInTheDocument());
    expect(screen.queryByText("מקבל/ת את ההצעה")).not.toBeInTheDocument();
  });

  it("shows an already-answered confirmation for a proposal in a final status", async () => {
    fetchProposalSummaryMock.mockResolvedValueOnce({
      proposalId: "p3",
      type: "shift",
      status: "accepted",
      reasonHe: "סיבה",
      expiresAt: new Date(Date.now() + 3600_000).toISOString(),
      payload: {},
      request: null,
      parties: [],
    });
    renderPage();
    await waitFor(() => expect(screen.getByText("תודה! הסדרן/ית יעדכנו את הסידור")).toBeInTheDocument());
  });
});
