import { fireEvent, render, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { he } from "@/i18n/he";

import type { WaitlistGroup } from "../types";
import { WaitlistGroupSheet } from "./WaitlistGroupSheet";

const mocks = vi.hoisted(() => ({ resolve: vi.fn(), cancel: vi.fn() }));
vi.mock("../hooks", () => ({
  useResolveWaitlistGroupMutation: () => ({ mutateAsync: mocks.resolve, isPending: false }),
  useCancelWaitlistGroupMutation: () => ({ mutateAsync: mocks.cancel, isPending: false }),
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn() } }));

const group: WaitlistGroup = {
  id: "group-1",
  department_id: "dept-1",
  week_start: "2026-09-13",
  day: "2026-09-16",
  starts_at: "2026-09-16T06:00:00+03:00",
  ends_at: "2026-09-16T10:00:00+03:00",
  status: "open",
  ride_id: null,
  resolved_by: null,
  resolved_at: null,
  version: 3,
  created_at: "2026-09-16T06:00:00+03:00",
  updated_at: "2026-09-16T06:00:00+03:00",
  members: [
    { request_id: "req-1", profile_id: "profile-1", name: "דנה", depart_at: "2026-09-16T06:00:00+03:00", return_at: "2026-09-16T10:00:00+03:00", adults: 1, child_seats: 0, boosters: 0, destination: "עפולה", chosen: null },
    { request_id: "req-2", profile_id: "profile-2", name: "רון", depart_at: "2026-09-16T06:15:00+03:00", return_at: "2026-09-16T09:45:00+03:00", adults: 1, child_seats: 0, boosters: 0, destination: "עפולה", chosen: null },
  ],
};

beforeEach(() => {
  mocks.resolve.mockReset().mockResolvedValue({});
  mocks.cancel.mockReset().mockResolvedValue({});
});

describe("WaitlistGroupSheet", () => {
  it("a participant can tick, pick a driver and confirm", async () => {
    const onOpenChange = vi.fn();
    render(
      <WaitlistGroupSheet
        group={group}
        departmentId="dept-1"
        weekStart="2026-09-13"
        profileId="profile-1"
        canManageWeek={false}
        onOpenChange={onOpenChange}
      />,
    );
    expect(screen.getByText(he.waitlist.sheetTitle)).toBeVisible();
    expect(screen.queryByText(he.waitlist.readOnlyHint)).not.toBeInTheDocument();
    // Nothing ticked yet — the confirm button is disabled.
    expect(screen.getByRole("button", { name: he.waitlist.confirm })).toBeDisabled();

    fireEvent.click(screen.getByRole("checkbox", { name: "דנה" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "רון" }));
    expect(screen.getByRole("button", { name: he.waitlist.confirm })).not.toBeDisabled();

    fireEvent.click(screen.getByRole("button", { name: he.waitlist.confirm }));
    const dialog = screen.getByRole("dialog", { name: he.waitlist.confirm });
    fireEvent.click(within(dialog).getByRole("button", { name: he.waitlist.confirm }));

    expect(mocks.resolve).toHaveBeenCalledExactlyOnceWith({
      groupId: "group-1",
      requestIds: ["req-1", "req-2"],
      expectedVersion: 3,
    });
  });

  it("a non-participant, non-Sadran viewer only gets the read-only hint", () => {
    render(
      <WaitlistGroupSheet
        group={group}
        departmentId="dept-1"
        weekStart="2026-09-13"
        profileId="someone-else"
        canManageWeek={false}
        onOpenChange={vi.fn()}
      />,
    );
    expect(screen.getByText(he.waitlist.readOnlyHint)).toBeVisible();
    expect(screen.queryByRole("checkbox")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: he.waitlist.confirm })).not.toBeInTheDocument();
  });

  it("the Sadran sees the cancel-group action even without being a participant", () => {
    render(
      <WaitlistGroupSheet
        group={group}
        departmentId="dept-1"
        weekStart="2026-09-13"
        profileId="sadran-profile"
        canManageWeek
        onOpenChange={vi.fn()}
      />,
    );
    expect(screen.getByRole("button", { name: he.waitlist.cancelGroup })).toBeVisible();
  });
});
