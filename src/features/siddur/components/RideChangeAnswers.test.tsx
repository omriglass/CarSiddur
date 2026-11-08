import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { he } from "@/i18n/he";

import { RideChangeAnswers } from "./RideChangeAnswers";

const ME = "me";
const change = {
  id: "c1", requester_id: "other", requester: { full_name: "אגתה" },
  starts_at: "2041-01-13T08:00:00+02:00", ends_at: "2041-01-13T12:00:00+02:00",
  parties: [{ profile_id: ME, ride_id: "r1", accepted: null, cut: "start", new_starts_at: "2041-01-13T12:30:00+02:00", new_ends_at: null }],
};
let changes: unknown[] = [change];

vi.mock("@/features/auth/useSession", () => ({ useSession: () => ({ session: { user: { id: ME } } }) }));
vi.mock("@/features/rides/hooks", () => ({
  useRideChanges: () => ({ data: changes, isSuccess: true }),
  useRespondRideChangeMutation: () => ({ mutate: vi.fn(), isPending: false }),
  useCancelRideChangeMutation: () => ({ mutate: vi.fn(), isPending: false }),
}));
vi.mock("../hooks", () => ({
  useMyUpcomingRides: () => ({ data: [{ id: "r1", starts_at: "2041-01-13T09:00:00+02:00", ends_at: "2041-01-13T17:00:00+02:00" }] }),
}));

const at = (url: string) => render(<MemoryRouter initialEntries={[url]}><RideChangeAnswers /></MemoryRouter>);

describe("RideChangeAnswers: the push's link (REQ §13.203 c)", () => {
  const scroll = vi.fn();
  beforeEach(() => {
    changes = [change];
    scroll.mockClear();
    Element.prototype.scrollIntoView = scroll;
  });

  it("scrolls to and marks the linked card", () => {
    const { container } = at("/inbox?change=c1");
    expect(container.querySelector("#change-c1")).toHaveAttribute("data-linked", "true");
    expect(scroll).toHaveBeenCalled();
  });

  it("an unlinked inbox marks nothing and does not scroll", () => {
    const { container } = at("/inbox");
    expect(container.querySelector("#change-c1")).not.toHaveAttribute("data-linked");
    expect(scroll).not.toHaveBeenCalled();
  });

  it("a link to a request already answered or withdrawn says so", () => {
    changes = [];
    at("/inbox?change=c1");
    expect(screen.getByTestId("ride-change-settled")).toHaveTextContent(he.rideEditing.linkSettled);
  });
});
