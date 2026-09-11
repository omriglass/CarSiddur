import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { StatusBadge } from "./StatusBadge";

import type { Database } from "@/integrations/supabase/types";

// Mirrors `Database["public"]["Enums"]` (src/integrations/supabase/types.ts,
// generated) exactly. `StatusBadge`'s per-kind maps are already exhaustive
// at compile time (each is a `Record<Enum, StatusMeta>`, so a missing/added
// enum literal fails `npm run typecheck`); this test is the runtime
// belt-and-suspenders check that every literal actually renders without
// throwing and without falling back to an empty label.
const REQUEST_STATUSES: readonly Database["public"]["Enums"]["request_status"][] = [
  "draft",
  "submitted",
  "proposed",
  "assigned",
  "merged",
  "waitlisted",
  "denied",
  "external",
  "withdrawn",
  "cancelled",
];

const PROPOSAL_STATUSES: readonly Database["public"]["Enums"]["proposal_status"][] = [
  "draft",
  "sent",
  "accepted",
  "declined",
  "expired",
  "applied",
  "withdrawn",
];

const RIDE_STATUSES: readonly Database["public"]["Enums"]["ride_status"][] = [
  "draft",
  "confirmed",
  "flagged",
  "cancelled",
];

const CAR_STATUSES: readonly Database["public"]["Enums"]["car_status"][] = [
  "active",
  "maintenance",
  "retired",
];

const WEEK_PHASES: readonly Database["public"]["Enums"]["week_phase"][] = [
  "upcoming",
  "open",
  "solving",
  "published",
  "live",
  "archived",
];

const CAR_ISSUE_STATUSES: readonly Database["public"]["Enums"]["car_issue_status"][] = ["open", "resolved"];

// `ParsedInviteRowStatus` (src/features/admin/members/lib/parseInviteLines.ts)
// mirrored here — a plain TS union, not a DB enum (see StatusBadge.tsx's
// own `InviteRowStatus` type comment).
const INVITE_ROW_STATUSES = ["new", "existing", "invalid_email", "duplicate"] as const;

describe("StatusBadge", () => {
  it.each(REQUEST_STATUSES)("renders request status '%s' with a non-empty label", (status) => {
    const { container } = render(<StatusBadge kind="request" status={status} />);
    expect(container.textContent).toBeTruthy();
  });

  it.each(PROPOSAL_STATUSES)("renders proposal status '%s' with a non-empty label", (status) => {
    const { container } = render(<StatusBadge kind="proposal" status={status} />);
    expect(container.textContent).toBeTruthy();
  });

  it.each(RIDE_STATUSES)("renders ride status '%s' with a non-empty label", (status) => {
    const { container } = render(<StatusBadge kind="ride" status={status} />);
    expect(container.textContent).toBeTruthy();
  });

  it.each(CAR_STATUSES)("renders car status '%s' with a non-empty label", (status) => {
    const { container } = render(<StatusBadge kind="car" status={status} />);
    expect(container.textContent).toBeTruthy();
  });

  it.each(WEEK_PHASES)("renders week phase '%s' with a non-empty label", (status) => {
    const { container } = render(<StatusBadge kind="week" status={status} />);
    expect(container.textContent).toBeTruthy();
  });

  it.each(CAR_ISSUE_STATUSES)("renders car issue status '%s' with a non-empty label", (status) => {
    const { container } = render(<StatusBadge kind="carIssue" status={status} />);
    expect(container.textContent).toBeTruthy();
  });

  it.each(INVITE_ROW_STATUSES)("renders invite row status '%s' with a non-empty label", (status) => {
    const { container } = render(<StatusBadge kind="inviteRow" status={status} />);
    expect(container.textContent).toBeTruthy();
  });
});
