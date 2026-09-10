import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { he } from "@/i18n/he";
import { paths } from "@/app/routes";

import { OpenProposalButton } from "./OpenProposalButton";

const mocks = vi.hoisted(() => ({
  navigate: vi.fn(),
  fetchLink: vi.fn(),
  toast: vi.fn(),
}));

vi.mock("react-router-dom", async () => {
  const actual = await vi.importActual<typeof import("react-router-dom")>("react-router-dom");
  return { ...actual, useNavigate: () => mocks.navigate };
});

vi.mock("sonner", () => ({ toast: mocks.toast }));

vi.mock("@/features/inbox/hooks", () => ({
  useProposalLinkMutation: () => ({ mutateAsync: mocks.fetchLink, isPending: false }),
}));

beforeEach(() => {
  mocks.navigate.mockReset();
  mocks.fetchLink.mockReset();
  mocks.toast.mockReset();
});

describe("OpenProposalButton", () => {
  it("navigates to the resolved /p/:token link", async () => {
    mocks.fetchLink.mockResolvedValue("/p/abc123");
    render(<OpenProposalButton proposalId="proposal-1" />);

    fireEvent.click(screen.getByRole("button", { name: he.proposal.open }));

    await waitFor(() => expect(mocks.fetchLink).toHaveBeenCalledWith("proposal-1"));
    expect(mocks.navigate).toHaveBeenCalledWith("/p/abc123");
    expect(mocks.toast).not.toHaveBeenCalled();
  });

  it("falls back to the inbox and shows a toast when no link can be found", async () => {
    mocks.fetchLink.mockResolvedValue(null);
    render(<OpenProposalButton proposalId="proposal-1" />);

    fireEvent.click(screen.getByRole("button", { name: he.proposal.open }));

    await waitFor(() => expect(mocks.navigate).toHaveBeenCalledWith(paths.inbox()));
    expect(mocks.toast).toHaveBeenCalledWith(he.proposal.openFallback);
  });

  it("falls back to the inbox when resolving the link errors", async () => {
    mocks.fetchLink.mockRejectedValue(new Error("boom"));
    render(<OpenProposalButton proposalId="proposal-1" />);

    fireEvent.click(screen.getByRole("button", { name: he.proposal.open }));

    await waitFor(() => expect(mocks.navigate).toHaveBeenCalledWith(paths.inbox()));
    expect(mocks.toast).toHaveBeenCalledWith(he.proposal.openFallback);
  });
});
