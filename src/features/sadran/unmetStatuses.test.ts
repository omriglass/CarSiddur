import { describe, expect, it } from "vitest";

import { isUnmetStatus, UNMET_REQUEST_STATUSES } from "./unmetStatuses";

import { REQUEST_STATUSES } from "@/lib/enums";

import type { RequestStatus } from "@/lib/enums";

// `REQUEST_STATUSES` (`src/lib/enums.ts`) is kept in sync with the generated
// `Database["public"]["Enums"]["request_status"]` by `assertSameEnum`; every
// value must be classified one way or the other here — this is the runtime
// belt-and-suspenders check that a newly added enum value does not silently
// fall through `isUnmetStatus`.

// Per unmetStatuses.ts's header comment (owner bug report #1): "not yet
// accepted" = still needs a ride and might still get one — submitted,
// proposed, waitlisted, denied. Everything else is either not yet a real
// request (draft), already placed (assigned/merged/external), or no longer
// active (withdrawn/cancelled).
const EXPECTED_UNMET: ReadonlySet<RequestStatus> = new Set([
  "submitted",
  "proposed",
  "waitlisted",
  "denied",
]);

describe("isUnmetStatus", () => {
  it.each(REQUEST_STATUSES)("classifies '%s' correctly", (status) => {
    expect(isUnmetStatus(status)).toBe(EXPECTED_UNMET.has(status));
  });

  it("every request_status value is classified as unmet or not (no gaps)", () => {
    for (const status of REQUEST_STATUSES) {
      expect(typeof isUnmetStatus(status)).toBe("boolean");
    }
  });

  it("UNMET_REQUEST_STATUSES matches the expected set exactly", () => {
    expect(new Set(UNMET_REQUEST_STATUSES)).toEqual(EXPECTED_UNMET);
  });

  it("assigned/merged/external requests are not unmet (already placed)", () => {
    expect(isUnmetStatus("assigned")).toBe(false);
    expect(isUnmetStatus("merged")).toBe(false);
    expect(isUnmetStatus("external")).toBe(false);
  });

  it("withdrawn/cancelled requests are not unmet (no longer active)", () => {
    expect(isUnmetStatus("withdrawn")).toBe(false);
    expect(isUnmetStatus("cancelled")).toBe(false);
  });

  it("draft requests are not unmet (not yet submitted)", () => {
    expect(isUnmetStatus("draft")).toBe(false);
  });
});
