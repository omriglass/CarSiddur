import { describe, expect, it } from "vitest";

import { waitlistGroupMemberSchema, waitlistGroupRowSchema } from "./schema";

const member = {
  request_id: "req-1",
  profile_id: "profile-1",
  name: "דנה",
  depart_at: "2026-09-16T06:00:00+03:00",
  return_at: "2026-09-16T10:00:00+03:00",
  adults: 1,
  child_seats: 0,
  boosters: 0,
  destination: "עפולה",
  chosen: null,
};

const row = {
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
  version: 1,
  created_at: "2026-09-16T06:00:00+03:00",
  updated_at: "2026-09-16T06:00:00+03:00",
  members: [member],
};

describe("waitlistGroupMemberSchema", () => {
  it("parses a valid member row", () => {
    expect(waitlistGroupMemberSchema.parse(member)).toEqual(member);
  });

  it("accepts chosen: true/false once resolved", () => {
    expect(waitlistGroupMemberSchema.parse({ ...member, chosen: true }).chosen).toBe(true);
    expect(waitlistGroupMemberSchema.parse({ ...member, chosen: false }).chosen).toBe(false);
  });

  it("rejects a member missing a required field", () => {
    const rest = Object.fromEntries(Object.entries(member).filter(([key]) => key !== "name"));
    expect(() => waitlistGroupMemberSchema.parse(rest)).toThrow();
  });
});

describe("waitlistGroupRowSchema", () => {
  it("parses a v_waitlist_groups row with its members array", () => {
    const parsed = waitlistGroupRowSchema.parse(row);
    expect(parsed.members).toHaveLength(1);
    expect(parsed.members[0]?.name).toBe("דנה");
  });

  it("rejects an unknown status", () => {
    expect(() => waitlistGroupRowSchema.parse({ ...row, status: "bogus" })).toThrow();
  });
});
