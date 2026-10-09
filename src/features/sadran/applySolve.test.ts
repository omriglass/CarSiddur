import { describe, expect, it } from "vitest";

import type { FixedRide } from "@/solver";
import { boardRideToFixedRide, buildApplyPayload, computeFullResolveDiff, draftFixedRides, restrictInputToDay, selectOpenRequests, servedOf } from "./applySolve";
import { solve } from "@/solver";
import { dateKey } from "@/lib/time";
import { baseInput, makeCar, makeRequest, makeSeriesLegs, slotMs, WEEK_START_MS } from "@/solver/__fixtures__/gen";

import type { RequestRow, BoardRide, ProposalRow } from "./api";
import type { SolverContext } from "./applySolve";
import type { SolverOutput } from "@/solver";

describe("servedOf (maps v_board_rides.served[].child_names onto childNames)", () => {
  function ride(served: unknown[]): BoardRide {
    return { served } as unknown as BoardRide;
  }

  it("maps child_names onto childNames for each entry that has them", () => {
    const entries = servedOf(
      ride([
        { request_id: "r1", role: "driver", leg: "both", car_mode: "keep", adults: 1, child_seats: 0, boosters: 0, luggage: false, child_names: ["Yossi"] },
        { request_id: "r2", role: "passenger", leg: "both", car_mode: "keep", adults: 1, child_seats: 1, boosters: 0, luggage: false, child_names: [] },
      ]),
    );
    expect(entries.find((e) => e.request_id === "r1")?.childNames).toEqual(["Yossi"]);
    expect(entries.find((e) => e.request_id === "r2")?.childNames).toBeUndefined();
  });

  it("filters out entries without a request_id, regardless of child_names", () => {
    const entries = servedOf(ride([{ request_id: null, role: "driver", leg: "both", car_mode: "keep", adults: 1, child_seats: 0, boosters: 0, luggage: false }]));
    expect(entries).toEqual([]);
  });

  it("returns an empty list for a ride with no served jsonb", () => {
    expect(servedOf(ride([]))).toEqual([]);
  });
});

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

it("preserves a driverless reservation as a fixed constraint during subsequent solves", () => {
  const reservation = boardRideToFixedRide({ id: "reservation", car_id: "car", driver_id: null,
    starts_at: new Date(slotMs(32)).toISOString(), ends_at: new Date(slotMs(48)).toISOString(),
    origin_id: "home", destination_id: "home", served: [], notes: "Reserved", is_pinned: true,
  } as unknown as BoardRide, WEEK_START_MS);
  expect(reservation).not.toBeNull();
  const result = solve(baseInput({ cars: [makeCar("car")], fixedRides: [reservation!], requests: [
    makeRequest({ id: "request", departureMs: slotMs(36), returnMs: slotMs(44) }),
  ] }));
  expect(result.assignments.find((r) => r.rideId === "reservation")?.source).toBe("fixed");
  expect(result.assignments.some((r) => r.servedRequestIds.includes("request"))).toBe(false);
});

// REQ §89 (owner 2026-09-15): an unclaimed automatic relocation ride is the DB's own
// chain-healing placeholder — it must never be pinned as a solver constraint, since the DB
// cancels it the moment a real leg covers the gap. A *claimed* one (`driver_id` set) is an
// ordinary one-way leg and stays fixed like any other ride.
it("skips an unclaimed automatic relocation ride (auto_relocation, no driver) as a fixed constraint", () => {
  const fixed = boardRideToFixedRide({
    id: "relocation", car_id: "car", driver_id: null, auto_relocation: true,
    starts_at: new Date(slotMs(32)).toISOString(), ends_at: new Date(slotMs(40)).toISOString(),
    origin_id: "away", destination_id: "home", served: [],
  } as unknown as BoardRide, WEEK_START_MS);
  expect(fixed).toBeNull();
});

it("keeps a claimed automatic relocation ride (auto_relocation with a driver) as a fixed constraint", () => {
  const fixed = boardRideToFixedRide({
    id: "relocation-claimed", car_id: "car", driver_id: "member-1", auto_relocation: true,
    starts_at: new Date(slotMs(32)).toISOString(), ends_at: new Date(slotMs(40)).toISOString(),
    origin_id: "away", destination_id: "home", served: [],
  } as unknown as BoardRide, WEEK_START_MS);
  expect(fixed).not.toBeNull();
  expect(fixed?.id).toBe("relocation-claimed");
});

it("keeps a driverless Sadran car move (pin_reason CAR_MOVE) as a fixed, location-deciding ride (R6B6)", () => {
  const fixed = boardRideToFixedRide({
    id: "car-move", car_id: "car", driver_id: null, auto_relocation: true, pin_reason: "CAR_MOVE",
    starts_at: new Date(slotMs(32)).toISOString(), ends_at: new Date(slotMs(40)).toISOString(),
    origin_id: "away", destination_id: "home", served: [],
  } as unknown as BoardRide, WEEK_START_MS);
  expect(fixed?.id).toBe("car-move");
  expect(fixed?.destinationId).toBe("home");
  expect(fixed?.locationNeutral).toBeUndefined();
});

it("solves around coordinator-approved adjacent fixed rides while retaining normal buffers for new rides", () => {
  const fixed = [
    { id: "late-id", start: 32, end: 40, turnaround: 0 },
    { id: "early-id", start: 40, end: 48, turnaround: null },
  ].map((r) => boardRideToFixedRide({ id: r.id, car_id: "car", driver_id: null,
    starts_at: new Date(slotMs(r.start)).toISOString(), ends_at: new Date(slotMs(r.end)).toISOString(),
    origin_id: "home", destination_id: "home", served: [], turnaround_override_minutes: r.turnaround,
  } as unknown as BoardRide, WEEK_START_MS)!);
  const result = solve(baseInput({ cars: [makeCar("car")], fixedRides: fixed, requests: [
    makeRequest({ id: "new", departureMs: slotMs(50), returnMs: slotMs(56) }),
  ] }));
  expect(result.assignments.filter((r) => r.source === "fixed")).toHaveLength(2);
  expect(result.assignments.some((r) => r.servedRequestIds.includes("new"))).toBe(true);
});

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

describe("buildApplyPayload (driverless rides, REQ §13.88/§13.89)", () => {
  const base = { weekStartMs: WEEK_START_MS, policyVersionId: "policy", startedAtMs: 0, finishedAtMs: 1, inputHash: "h", requestsById: new Map<string, RequestRow>() };
  function assignment(overrides: Record<string, unknown>) {
    return {
      id: "a1", carId: "car", window: { start: 40, end: 44 }, originId: "home", destinationId: "home",
      legs: [], servedRequestIds: [], passengers: { adults: 0, childSeats: 0, boosters: 0 }, luggageCount: 0,
      source: "solver", reasonCode: "PLACED_NEEDS_DRIVER", reason: "", ...overrides,
    } as unknown as SolverOutput["assignments"][number];
  }

  it("sends driver_id null (never \"\") and flags a serve-nobody driverless ride as an automatic relocation", () => {
    const payload = buildApplyPayload({ ...base, output: emptyOutput({ assignments: [assignment({ originId: "dest", destinationId: "home" })] }) });
    expect(payload.rides[0]!.driver_id).toBeNull();
    expect(payload.rides[0]!.auto_relocation).toBe(true);
  });

  it("never sends the solver's __free_text__ pseudo place as a ride origin/destination (not a uuid)", () => {
    const payload = buildApplyPayload({ ...base, output: emptyOutput({ assignments: [assignment({ originId: "home", destinationId: "__free_text__", driverMemberId: "m" })] }) });
    expect(payload.rides[0]).toMatchObject({ origin_id: "home", destination_id: "home" });
  });

  it("keeps a driven ride as is: driver_id set, no relocation flag", () => {
    const payload = buildApplyPayload({ ...base, output: emptyOutput({ assignments: [assignment({ driverMemberId: "member-1" })] }) });
    expect(payload.rides[0]!.driver_id).toBe("member-1");
    expect(payload.rides[0]!.auto_relocation).toBeUndefined();
  });
});

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

describe("boardRideToFixedRide large luggage (REQ §13.111 a)", () => {
  const rideWith = (served: object[]) => ({
    id: "ride-1", car_id: "car-1", starts_at: "2026-09-08T05:00:00Z", ends_at: "2026-09-08T09:00:00Z",
    origin_id: "home", destination_id: "home", driver_id: "m1", status: "confirmed", served,
  }) as unknown as BoardRide;
  const entry = (id: string, extra: object) => ({ request_id: id, role: "passenger", leg: "both", car_mode: "keep", adults: 1, child_seats: 0, boosters: 0, luggage: true, ...extra });
  it("counts only the luggage requests that still need a large trunk (a waived one does not)", () => {
    const fixed = boardRideToFixedRide(rideWith([entry("a", {}), entry("b", { luggage_waived: true }), entry("c", { luggage: false })]), Date.parse("2026-09-06T00:00:00Z"));
    expect(fixed?.luggageCount).toBe(1);
  });
});

describe("computeFullResolveDiff (confirm-dialog data for 're-solve the whole week')", () => {
  it("lists every currently-replaceable ride and counts requests that would lose their assignment", () => {
    const context: SolverContext = {
      boardRides: [],
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
      boardRides: [],
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

it("persists a 23:59 return exactly instead of the solver's conservative midnight slot", () => {
  const returnAt = new Date(slotMs(96) - 60_000).toISOString();
  const output = solve(baseInput({ cars: [makeCar("C1")], requests: [makeRequest({ id: "late", departureMs: slotMs(88), returnMs: Date.parse(returnAt) })] }));
  const payload = buildApplyPayload({ output, weekStartMs: WEEK_START_MS, policyVersionId: "policy", startedAtMs: 0, finishedAtMs: 1,
    inputHash: "fixture", requestsById: new Map([["late", { id: "late", requester_id: "m1", return_at: returnAt } as RequestRow]]) });
  expect(payload.rides).toHaveLength(1);
  expect(payload.rides[0]?.ends_at).toBe(returnAt);
});

describe("board drafts in the solver context (REQ §13.94)", () => {
  it("selectOpenRequests leaves requests with a draft/sent/accepted proposal alone", () => {
    const requests = [req({ id: "r1", status: "submitted" }), req({ id: "r2", status: "submitted" }), req({ id: "r3", status: "waitlisted" })];
    const open = selectOpenRequests(requests, new Set(), new Set(["r2"]));
    expect(open.map((r) => r.id)).toEqual(["r1", "r3"]);
  });

  it("a draft shift becomes a fixed block on its car for exactly its window", () => {
    const request = { ...req({ id: "r1", status: "submitted" }), trip_shape: "round_trip", origin_id: null, destination_id: "dest", depart_at: new Date(slotMs(10)).toISOString(), return_at: new Date(slotMs(20)).toISOString(), adults: 1, child_seats: 0, boosters: 0, has_luggage: false } as unknown as RequestRow;
    const proposal = { id: "p1", type: "shift", status: "draft", request_id: "r1", ride_id: null,
      payload: { car_id: "carB", depart_at: new Date(slotMs(12)).toISOString(), return_at: new Date(slotMs(22)).toISOString() } } as unknown as ProposalRow;
    const fixed = draftFixedRides([proposal], [request], [], [], [{ id: "dest", travel_minutes: 30 }], "home", WEEK_START_MS);
    expect(fixed).toHaveLength(1);
    expect(fixed[0]).toMatchObject({ id: "draft:p1", carId: "carB", window: { start: 12, end: 22 }, servedRequestIds: ["r1"], originId: "home" });
  });

  it("sent proposals add no fixed block (their ride/ghost already exists)", () => {
    const proposal = { id: "p1", type: "shift", status: "sent", request_id: "r1", payload: { car_id: "carB", depart_at: new Date(slotMs(12)).toISOString() } } as unknown as ProposalRow;
    expect(draftFixedRides([proposal], [req({ id: "r1", status: "proposed" }) as unknown as RequestRow], [], [], [], "home", WEEK_START_MS)).toEqual([]);
  });
});

describe("draftFixedRides overlap handling", () => {
  const request = { ...req({ id: "r1", status: "submitted" }), trip_shape: "round_trip", origin_id: null, destination_id: "dest", depart_at: new Date(slotMs(10)).toISOString(), return_at: new Date(slotMs(20)).toISOString(), adults: 1, child_seats: 0, boosters: 0, has_luggage: false } as unknown as RequestRow;
  const draft = { id: "p1", type: "shift", status: "draft", request_id: "r1", ride_id: null,
    payload: { car_id: "carB", depart_at: new Date(slotMs(12)).toISOString(), return_at: new Date(slotMs(22)).toISOString() } } as unknown as ProposalRow;
  const own = { id: "ride1", carId: "carB", window: { start: 10, end: 20 }, servedRequestIds: ["r1"] } as unknown as FixedRide;
  const other = { id: "ride2", carId: "carB", window: { start: 21, end: 30 }, servedRequestIds: ["r2"] } as unknown as FixedRide;

  it("replaces the request's own ride block", () => {
    const fixed = draftFixedRides([draft], [request], [], [own], [{ id: "dest", travel_minutes: 30 }], "home", WEEK_START_MS);
    expect(fixed.map((f) => f.id)).toEqual(["draft:p1"]);
  });
  it("skips a draft that genuinely overlaps another fixed ride instead of crashing", () => {
    const fixed = draftFixedRides([draft], [request], [], [own, other], [{ id: "dest", travel_minutes: 30 }], "home", WEEK_START_MS);
    expect(fixed.map((f) => f.id)).toEqual(["ride2"]);
  });
});

describe("draftFixedRides: a plan-B draft (REQ §13.112 a)", () => {
  const request = { ...req({ id: "r1", status: "submitted" }), trip_shape: "round_trip", origin_id: null, destination_id: "dest", depart_at: new Date(slotMs(36)).toISOString(), return_at: new Date(slotMs(44)).toISOString(), adults: 1, child_seats: 0, boosters: 0, has_luggage: false } as unknown as RequestRow;
  const draft = { id: "p1", type: "alternative", status: "draft", request_id: "r1", ride_id: null,
    payload: { car_id: "carB", depart_at: new Date(slotMs(63)).toISOString(), arrive_by: new Date(slotMs(64)).toISOString(),
      pickup_at: new Date(slotMs(72)).toISOString(), return_at: new Date(slotMs(73)).toISOString(), drop_place_id: "stn" } } as unknown as ProposalRow;

  it("holds the car for the drop-off and the pickup as two chauffeur blocks and leaves the main window alone", () => {
    const mainRide = { id: "main", carId: "carA", window: { start: 36, end: 44 }, servedRequestIds: ["r1"] } as unknown as FixedRide;
    const fixed = draftFixedRides([draft], [request], [], [mainRide], [{ id: "dest", travel_minutes: 30 }], "home", WEEK_START_MS);
    const blocks = fixed.filter((f) => f.id.startsWith("draft:p1"));
    expect(blocks.map((f) => [f.id, f.carId, f.window.start, f.window.end])).toEqual([
      ["draft:p1:out", "carB", 63, 66], ["draft:p1:return", "carB", 70, 73],
    ]);
    expect(blocks[0]!.legs[0]).toMatchObject({ requestId: "r1", leg: "out", carMode: "chauffeur", role: "passenger" });
    expect(fixed.some((f) => f.id === "main")).toBe(true);
  });
  it("skips a leg that collides with another block of that car", () => {
    const other = { id: "o", carId: "carB", window: { start: 60, end: 67 }, servedRequestIds: ["r2"] } as unknown as FixedRide;
    const fixed = draftFixedRides([draft], [request], [], [other], [], "home", WEEK_START_MS);
    expect(fixed.map((f) => f.id)).toEqual(["o", "draft:p1:return"]);
  });
});

describe("restrictInputToDay (per-day autofill, R7U1)", () => {
  it("keeps only requests anchored on the chosen Jerusalem day", () => {
    const input = baseInput({ requests: [
      makeRequest({ id: "a", departureMs: slotMs(40) }),
      makeRequest({ id: "b", departureMs: slotMs(2 * 96 + 40) }),
    ] });
    const dayOfA = dateKey(new Date(slotMs(40)));
    restrictInputToDay(input, dayOfA);
    expect(input.requests.map((r) => r.id)).toEqual(["a"]);
  });

  it("autofilling the last day of a series places the whole series (R8B1)", () => {
    const legs = makeSeriesLegs({ seriesId: "S1", seriesCount: 3, dayIndices: [0, 1, 2] });
    const input = baseInput({ cars: [makeCar("C1")], requests: legs });
    const lastDay = dateKey(new Date(legs[2]!.departureMs ?? legs[2]!.returnMs!));
    restrictInputToDay(input, lastDay);
    const out = solve(input);
    expect(out.unmet).toHaveLength(0);
    expect(out.assignments.filter((a) => a.seriesId === "S1")).toHaveLength(3);
  });

  it("lets a series touching the day through with all its days (R8B1)", () => {
    const input = baseInput({ requests: [
      makeRequest({ id: "s1", seriesId: "S", departureMs: slotMs(40) }),
      makeRequest({ id: "s2", seriesId: "S", departureMs: slotMs(96 + 40) }),
      makeRequest({ id: "s3", seriesId: "S", departureMs: slotMs(2 * 96 + 40) }),
      makeRequest({ id: "other", seriesId: "T", departureMs: slotMs(96 + 40) }),
      makeRequest({ id: "x", departureMs: slotMs(96 + 41) }),
    ] });
    restrictInputToDay(input, dateKey(new Date(slotMs(2 * 96 + 40))));
    expect(input.requests.map((r) => r.id)).toEqual(["s1", "s2", "s3"]);
  });
});
