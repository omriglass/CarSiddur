import { describe, expect, it } from "vitest";

import { buildApplyPayload, computeFullResolveDiff, selectOpenRequests } from "./applySolve";

import type { RequestRow } from "./api";
import type { SolverContext } from "./applySolve";
import type { SolverOutput } from "@/solver";

// Regression coverage for the MAJOR BUG investigation (docs/UX_FLOWS.md §19
// "Solve/apply semantics after owner testing"): owner report after the
// previous fix pass was "clicking Solve and Autofill STILL sometimes makes
// certain rides disappear." Root cause: `gatherSolverContext` decided which
// requests were "open" (fed to the solver) purely by request *status*
// (`submitted`/`waitlisted`), independently of which rides were passed as
// `fixedRides` (decided by `is_pinned`). A request already `assigned`/
// `merged` by a previous solve's own *unpinned* ride fell into neither
// bucket — invisible to the solver, so a 'full' re-solve's own
// `apply_solver_result` deleted its ride without the solver ever being
// asked to replace it. `selectOpenRequests` is the extracted, now-fixed
// filter; these tests exercise exactly that shape directly.

function req(overrides: Partial<{ id: string; status: string }> = {}) {
  return { id: "req-1", status: "submitted", ...overrides };
}

describe("selectOpenRequests (bug-fix: assigned-by-unpinned-ride requests must reopen)", () => {
  it("includes submitted and waitlisted requests with no fixed ride", () => {
    const requests = [req({ id: "r1", status: "submitted" }), req({ id: "r2", status: "waitlisted" })];
    const open = selectOpenRequests(requests, new Set());
    expect(open.map((r) => r.id)).toEqual(["r1", "r2"]);
  });

  it("THE BUG: reopens an assigned request whose ride is not fixed (full-mode re-solve)", () => {
    // Exactly the scenario from the owner's repro: a previous solve placed
    // req-1 on an unpinned ride; a 'full' re-solve's `fixedRides` only
    // contains genuinely pinned rides, so req-1's id is *not* in
    // `fixedRequestIds`. The old status-only filter (`{submitted,
    // waitlisted}`) silently dropped it; the fix must keep it.
    const requests = [req({ id: "r1", status: "assigned" }), req({ id: "r2", status: "merged" })];
    const open = selectOpenRequests(requests, new Set());
    expect(open.map((r) => r.id).sort()).toEqual(["r1", "r2"]);
  });

  it("excludes an assigned/merged request whose ride IS fixed (pinned, accepted proposal, temp-car owner)", () => {
    const requests = [req({ id: "r1", status: "assigned" }), req({ id: "r2", status: "merged" })];
    const open = selectOpenRequests(requests, new Set(["r1", "r2"]));
    expect(open).toEqual([]);
  });

  it("never reopens draft, proposed, denied, external, withdrawn or cancelled requests", () => {
    const requests = [
      req({ id: "r1", status: "draft" }),
      req({ id: "r2", status: "proposed" }),
      req({ id: "r3", status: "denied" }),
      req({ id: "r4", status: "external" }),
      req({ id: "r5", status: "withdrawn" }),
      req({ id: "r6", status: "cancelled" }),
    ];
    expect(selectOpenRequests(requests, new Set())).toEqual([]);
  });
});

function emptyOutput(overrides: Partial<SolverOutput> = {}): SolverOutput {
  return {
    policyId: "p",
    policyVersion: 1,
    assignments: [],
    unmet: [],
    mergeOpportunities: [],
    carsAway: [],
    warnings: [],
    stats: { served: 0, unmet: 0, needsDriver: 0, relocations: 0, budgetExhausted: false, elapsedMs: 0 },
    ...overrides,
  };
}

describe("buildApplyPayload (every reopened request lands in rides or request_statuses)", () => {
  it("marks every unmet request waitlisted, so a reopened-but-now-unplaceable request is never left dangling", () => {
    const requestsById = new Map<string, RequestRow>();
    const output = emptyOutput({
      unmet: [{ requestId: "r1", score: 1, blockers: [], suggestions: [], reasonCode: "UNMET_NO_CAR", reason: "" }],
    });
    const payload = buildApplyPayload({
      output,
      weekStartMs: 0,
      policyVersionId: "pv",
      startedAtMs: 0,
      finishedAtMs: 1,
      inputHash: "h",
      requestsById,
      mode: "full",
    });
    expect(payload.request_statuses).toEqual([{ request_id: "r1", status: "waitlisted", status_reason: "WAITLISTED_NO_CAR" }]);
    expect(payload.mode).toBe("full");
  });
});

describe("computeFullResolveDiff (confirm-dialog data for 're-solve the whole week')", () => {
  it("lists every currently-replaceable ride and counts requests that would lose their assignment", () => {
    const context: SolverContext = {
      input: {} as SolverContext["input"],
      weekStartMs: 0,
      policyVersionId: "pv",
      requestsById: new Map(),
      replaceableRides: [
        {
          id: "ride-1",
          car_id: "car-1",
          starts_at: "2026-09-08T05:00:00Z",
          ends_at: "2026-09-08T09:00:00Z",
          served: [{ request_id: "r1", role: "driver", leg: "both", car_mode: "keep", adults: 1, child_seats: 0, boosters: 0, luggage: false }],
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
        } as any,
      ],
    };
    const output = emptyOutput({
      unmet: [{ requestId: "r1", score: 1, blockers: [], suggestions: [], reasonCode: "UNMET_NO_CAR", reason: "" }],
    });
    const diff = computeFullResolveDiff(context, output);
    expect(diff.changedOrRemovedRides).toHaveLength(1);
    expect(diff.changedOrRemovedRides[0]?.rideId).toBe("ride-1");
    expect(diff.requestsLosingAssignment).toBe(1);
  });

  it("counts zero when the re-solve reassigns every previously-served request", () => {
    const context: SolverContext = {
      input: {} as SolverContext["input"],
      weekStartMs: 0,
      policyVersionId: "pv",
      requestsById: new Map(),
      replaceableRides: [
        {
          id: "ride-1",
          car_id: "car-1",
          starts_at: "2026-09-08T05:00:00Z",
          ends_at: "2026-09-08T09:00:00Z",
          served: [{ request_id: "r1", role: "driver", leg: "both", car_mode: "keep", adults: 1, child_seats: 0, boosters: 0, luggage: false }],
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
        } as any,
      ],
    };
    const output = emptyOutput(); // r1 reassigned elsewhere, not in `unmet`
    const diff = computeFullResolveDiff(context, output);
    expect(diff.requestsLosingAssignment).toBe(0);
    // Still listed as "would change" — 'full' mode deletes+reinserts unconditionally.
    expect(diff.changedOrRemovedRides).toHaveLength(1);
  });
});
