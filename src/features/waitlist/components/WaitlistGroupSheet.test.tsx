import { fireEvent, render, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { he } from "@/i18n/he";

import type { WaitlistGroup } from "../types";
import { WaitlistGroupSheet } from "./WaitlistGroupSheet";

const mocks = vi.hoisted(() => ({ resolve: vi.fn(), cancel: vi.fn(), join: vi.fn(), navigate: vi.fn(), holds: [] as unknown[] }));
vi.mock("../hooks", () => ({
  useResolveWaitlistGroupMutation: () => ({ mutateAsync: mocks.resolve, isPending: false }),
  useCancelWaitlistGroupMutation: () => ({ mutateAsync: mocks.cancel, isPending: false }),
  useJoinWaitlistDiscussionMutation: () => ({ mutateAsync: mocks.join, isPending: false }),
  useWaitlistGroupHoldsQuery: () => ({ data: mocks.holds, isSuccess: true }),
}));
vi.mock("react-router-dom", () => ({ useNavigate: () => mocks.navigate }));
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
    { request_id: "req-1", profile_id: "profile-1", name: "דנה", depart_at: "2026-09-16T06:00:00+03:00", return_at: "2026-09-16T10:00:00+03:00", adults: 1, child_seats: 0, boosters: 0, destination: "עפולה", companions: ["עמוס"], chosen: null },
    { request_id: "req-2", profile_id: "profile-2", name: "רון", depart_at: "2026-09-16T06:15:00+03:00", return_at: "2026-09-16T09:45:00+03:00", adults: 1, child_seats: 0, boosters: 0, destination: "חיפה", companions: [], chosen: null },
  ],
};

beforeEach(() => {
  mocks.resolve.mockReset().mockResolvedValue({});
  mocks.cancel.mockReset().mockResolvedValue({});
  mocks.join.mockReset().mockResolvedValue({ group_id: "group-1" });
  mocks.navigate.mockReset();
  mocks.holds = [];
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

  it("shows the one-line summary: who, with whom, where to and when (REQ §13.157)", () => {
    render(<WaitlistGroupSheet group={group} departmentId="dept-1" weekStart="2026-09-13" profileId="profile-1" canManageWeek={false} onOpenChange={vi.fn()} />);
    expect(screen.getByTestId("waitlist-group-summary")).toHaveTextContent("דנה עם עמוס לעפולה");
    expect(screen.getByTestId("waitlist-group-summary")).toHaveTextContent(", או רון לחיפה");
  });

  it("an outsider opens the request form limited to the held car's free hours (REQ §13.157)", () => {
    mocks.holds = [{ group_id: "group-1", car_id: "car-1", held_from: group.starts_at, held_until: group.ends_at,
      gap_from: "2026-09-16T07:00:00+03:00", gap_until: "2026-09-16T18:00:00+03:00" }];
    render(<WaitlistGroupSheet group={group} departmentId="dept-1" weekStart="2026-09-13" profileId="someone-else" canManageWeek={false} onOpenChange={vi.fn()} />);
    fireEvent.click(screen.getByTestId("waitlist-join"));
    expect(mocks.navigate).toHaveBeenCalledExactlyOnceWith("/requests/new?week=2026-09-13&day=2026-09-16&time=07%3A00&end=10%3A00&group=group-1");
  });

  it("an outsider with an overlapping waiting request joins with it in one tap", async () => {
    render(
      <WaitlistGroupSheet group={group} departmentId="dept-1" weekStart="2026-09-13" profileId="someone-else" canManageWeek={false} onOpenChange={vi.fn()}
        myRequests={[{ id: "mine", requesterId: "someone-else", status: "waitlisted", statusReason: "WAITLISTED_NO_CAR",
          departAt: "2026-09-16T08:00:00+03:00", returnAt: "2026-09-16T11:00:00+03:00", weekStart: "2026-09-13" }]} />,
    );
    fireEvent.click(screen.getByTestId("waitlist-join-mine"));
    await vi.waitFor(() => expect(mocks.join).toHaveBeenCalledExactlyOnceWith("mine"));
  });

  it("an outsider sees no join button when the group holds no car", () => {
    render(<WaitlistGroupSheet group={group} departmentId="dept-1" weekStart="2026-09-13" profileId="someone-else" canManageWeek={false} onOpenChange={vi.fn()} />);
    expect(screen.queryByTestId("waitlist-join")).not.toBeInTheDocument();
    expect(screen.getByText(he.waitlist.joinNoHours)).toBeVisible();
  });
});
