import { describe, expect, it } from "vitest";

import {
  buildSolverInput,
  buildWeek,
  FREE_TEXT_DESTINATION_ID,
  parseFlexInterval,
  parseTimeToMinutes,
  type CarRow,
  type DestinationRow,
  type RequestRow,
  type SeatConfigRow,
} from "./buildSolverInput";

const DEPT = "dept-1";
const WEEK_START = "2026-09-06"; // a Sunday
const HOME = "dest-home";

function requestRow(overrides: Partial<RequestRow> = {}): RequestRow {
  return {
    id: "req-1",
    department_id: DEPT,
    week_start: WEEK_START,
    requester_id: "member-1",
    filed_by: "member-1",
    destination_id: "dest-a",
    destination_text: null,
    ride_type_id: "rt-work",
    trip_shape: "round_trip",
    one_way_car_mode: null,
    depart_at: "2026-09-08T05:00:00Z",
    return_at: "2026-09-08T10:00:00Z",
    flex_depart_early: "00:15:00",
    flex_depart_late: "0",
    flex_return_early: "0",
    flex_return_late: "1 day",
    adults: 1,
    child_seats: 0,
    boosters: 0,
    has_luggage: false,
    needs_car_at_destination: true,
    freed_slot_opt_out: false,
    is_late: false,
    join_ride_id: null,
    manual_boost: 0,
    manual_boost_reason: null,
    notes: null,
    status: "submitted",
    status_reason: null,
    submitted_at: "2026-09-05T10:00:00Z",
    template_id: null,
    updated_at: "2026-09-05T10:00:00Z",
    created_at: "2026-09-05T10:00:00Z",
    version: 1,
    changed_since_solve: false,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test fixture, not every generated column matters
    ...(overrides as any),
  } as RequestRow;
}

function carRow(overrides: Partial<CarRow> = {}): CarRow {
  return {
    id: "car-1",
    department_id: DEPT,
    name: "יונדאי 3",
    license_plate: "12-345-67",
    type: "shared",
    status: "active",
    owner_id: null,
    features: [],
    built_in_child_seats: 0,
    built_in_boosters: 0,
    notes: null,
    retired_at: null,
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test fixture
    ...(overrides as any),
  } as CarRow;
}

function destRow(overrides: Partial<DestinationRow> = {}): DestinationRow {
  return {
    id: "dest-a",
    name: "עפולה",
    aliases: [],
    zone: "north",
    distance_km: 20,
    travel_minutes: 30,
    public_transport_score: 2,
    is_approved: true,
    lat: null,
    lng: null,
    created_by: null,
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test fixture
    ...(overrides as any),
  } as DestinationRow;
}

const DEFAULT_SETTINGS = {
  turnaround_minutes: 30,
  detour_limit_minutes: 20,
  detour_limit_km: 15,
  chauffeur_dwell_minutes: 10,
  day_end_time: "23:59:00",
};

describe("parseFlexInterval", () => {
  it("parses the six allowed interval literals", () => {
    expect(parseFlexInterval("0")).toBe(0);
    expect(parseFlexInterval("00:00:00")).toBe(0);
    expect(parseFlexInterval("00:15:00")).toBe(15);
    expect(parseFlexInterval("00:30:00")).toBe(30);
    expect(parseFlexInterval("01:00:00")).toBe(60);
    expect(parseFlexInterval("02:00:00")).toBe(120);
    expect(parseFlexInterval("1 day")).toBe("day");
    expect(parseFlexInterval(null)).toBe(0);
  });
});

describe("parseTimeToMinutes", () => {
  it("parses HH:MM and HH:MM:SS", () => {
    expect(parseTimeToMinutes("23:59:00")).toBe(23 * 60 + 59);
    expect(parseTimeToMinutes("05:00")).toBe(300);
    expect(parseTimeToMinutes(null)).toBe(0);
  });
});

describe("buildWeek", () => {
  it("builds 7 full 96-slot days with dayEndSlot from day_end_time", () => {
    const { days } = buildWeek(WEEK_START, "23:59:00");
    expect(days).toHaveLength(7);
    expect(days[0]).toEqual({ dayIndex: 0, startSlot: 0, endSlot: 96, dayEndSlot: 95 });
    expect(days[1]!.startSlot).toBe(96);
  });

  it("respects an earlier day_end_time", () => {
    const { days } = buildWeek(WEEK_START, "20:00:00");
    // 20:00 = 1200 min -> slot 80 within the day
    expect(days[0]!.dayEndSlot).toBe(80);
  });
});

describe("buildSolverInput", () => {
  it("maps a round-trip request, a shared car and a destination", () => {
    const input = buildSolverInput({
      weekStart: WEEK_START,
      homeDestinationId: HOME,
      departmentSettings: DEFAULT_SETTINGS,
      requests: [requestRow()],
      rideTypeCodesById: { "rt-work": "work" },
      cars: [carRow()],
      seatConfigsByCarId: { "car-1": [{ id: "sc-1", car_id: "car-1", adults: 4, child_seats: 0, boosters: 0 }]  as SeatConfigRow[] },
      destinations: [destRow(), destRow({ id: HOME, name: "נבו", zone: "home", distance_km: null, travel_minutes: null, public_transport_score: null })],
      policy: { id: "p1", version: 1, rules: [] },
    });

    expect(input.homeLocationId).toBe(HOME);
    expect(input.cars).toHaveLength(1);
    expect(input.cars[0]).toMatchObject({ id: "car-1", type: "shared", luggageCapacity: 1 });
    expect(input.cars[0]!.seatConfigs).toEqual([{ adults: 4, childSeats: 0, boosters: 0 }]);

    expect(input.requests).toHaveLength(1);
    const r = input.requests[0]!;
    expect(r.rideType).toBe("work");
    expect(r.destinationId).toBe("dest-a");
    expect(r.flexDeparture).toEqual({ earlierMin: 15, laterMin: 0 });
    expect(r.flexReturn).toEqual({ earlierMin: 0, laterMin: "day" });
    expect(r.passengers).toEqual({ adults: 1, childSeats: 0, boosters: 0 });
    expect(typeof r.departureMs).toBe("number");
    expect(typeof r.returnMs).toBe("number");

    expect(input.destinations["dest-a"]!.zone).toBe("north");
    expect(input.destinations["dest-a"]!.publicTransportScore).toBeCloseTo(0.4);
  });

  it("excludes draft requests and falls back free-text destinations to the sentinel", () => {
    const input = buildSolverInput({
      weekStart: WEEK_START,
      homeDestinationId: HOME,
      departmentSettings: DEFAULT_SETTINGS,
      requests: [
        requestRow({ id: "draft-1", status: "draft" }),
        requestRow({ id: "free-1", destination_id: null, destination_text: "רופא שיניים" }),
      ],
      rideTypeCodesById: {},
      cars: [],
      seatConfigsByCarId: {},
      destinations: [],
      policy: { id: "p1", version: 1, rules: [] },
    });

    expect(input.requests.map((r) => r.id)).toEqual(["free-1"]);
    expect(input.requests[0]!.destinationId).toBe(FREE_TEXT_DESTINATION_ID);
    expect(input.destinations[FREE_TEXT_DESTINATION_ID]).toEqual({ id: FREE_TEXT_DESTINATION_ID, zone: "unknown" });
  });

  it("derives fairness from granted hours, not request volume", () => {
    const input = buildSolverInput({
      weekStart: WEEK_START,
      homeDestinationId: HOME,
      departmentSettings: DEFAULT_SETTINGS,
      requests: [],
      rideTypeCodesById: {},
      cars: [],
      seatConfigsByCarId: {},
      destinations: [],
      policy: { id: "p1", version: 1, rules: [] },
      fairness: [
        // Two two-hour grants equal one four-hour grant; only their total
        // granted hours matter, not how many requests led to them.
        { profile_id: "m1", granted_hours: 4 },
        { profile_id: "m2", granted_hours: 2 },
        { profile_id: "m3", granted_hours: 0 },
      ],
    });

    expect(input.stats.fairness.m1!.deficit).toBe(0);
    expect(input.stats.fairness.m2!.deficit).toBe(0.5);
    expect(input.stats.fairness.m3!.deficit).toBe(1);
  });

  it("computes luggage capacity 2 for cars with the large_trunk feature", () => {
    const input = buildSolverInput({
      weekStart: WEEK_START,
      homeDestinationId: HOME,
      departmentSettings: DEFAULT_SETTINGS,
      requests: [],
      rideTypeCodesById: {},
      cars: [carRow({ id: "car-2", features: ["large_trunk"] })],
      seatConfigsByCarId: {},
      destinations: [],
      policy: { id: "p1", version: 1, rules: [] },
    });

    expect(input.cars[0]!.luggageCapacity).toBe(2);
  });

  // MAJOR BUG investigation (docs/UX_FLOWS.md §19): a full re-solve needs
  // `previousAssignments` for continuity (SOLVER.md §5.1, `greedy.ts`'s
  // `continuityRank`) — this was never threaded through from
  // `gatherSolverContext`/`applySolve.ts` before this bug-fix pass.
  it("passes previousAssignments through unchanged for continuity", () => {
    const previousAssignments = [{ servedRequestIds: ["req-1"], carId: "car-1" }];
    const input = buildSolverInput({
      weekStart: WEEK_START,
      homeDestinationId: HOME,
      departmentSettings: DEFAULT_SETTINGS,
      requests: [],
      rideTypeCodesById: {},
      cars: [],
      seatConfigsByCarId: {},
      destinations: [],
      policy: { id: "p1", version: 1, rules: [] },
      previousAssignments,
    });

    expect(input.previousAssignments).toBe(previousAssignments);
  });

  it("omits previousAssignments when not supplied (e.g. 'remaining' mode)", () => {
    const input = buildSolverInput({
      weekStart: WEEK_START,
      homeDestinationId: HOME,
      departmentSettings: DEFAULT_SETTINGS,
      requests: [],
      rideTypeCodesById: {},
      cars: [],
      seatConfigsByCarId: {},
      destinations: [],
      policy: { id: "p1", version: 1, rules: [] },
    });

    expect(input.previousAssignments).toBeUndefined();
  });
});

it("only forwards a preference for an active shared car in the request's department", () => {
  for (const car of [carRow(), carRow({ department_id: "another-department" }), carRow({ type: "temporary" }), carRow({ status: "maintenance" })]) {
    const input = buildSolverInput({
      weekStart: WEEK_START, homeDestinationId: HOME, departmentSettings: DEFAULT_SETTINGS,
      requests: [requestRow({ preferred_car_id: "car-1" })], rideTypeCodesById: {}, cars: [car],
      seatConfigsByCarId: {}, destinations: [destRow()], policy: { id: "p", version: 1, rules: [] },
    });
    expect(input.requests[0]?.preferredCarId).toBe(car.department_id === DEPT && car.type === "shared" && car.status === "active" ? "car-1" : undefined);
  }
});

describe("multi-day series fields", () => {
  it("passes series_id/series_index/series_count through to the solver Request (SOLVER.md §3.x)", () => {
    const input = buildSolverInput({
      weekStart: WEEK_START,
      homeDestinationId: HOME,
      departmentSettings: DEFAULT_SETTINGS,
      requests: [
        requestRow({ id: "leg-1", series_id: "series-abc", series_index: 2, series_count: 4 }),
        requestRow({ id: "leg-2" }), // ordinary request: no series fields
      ],
      rideTypeCodesById: {},
      cars: [],
      seatConfigsByCarId: {},
      destinations: [destRow()],
      policy: { id: "p", version: 1, rules: [] },
    });

    const seriesLeg = input.requests.find((r) => r.id === "leg-1");
    expect(seriesLeg?.seriesId).toBe("series-abc");
    expect(seriesLeg?.seriesIndex).toBe(2);
    expect(seriesLeg?.seriesCount).toBe(4);

    const ordinary = input.requests.find((r) => r.id === "leg-2");
    expect(ordinary?.seriesId).toBeUndefined();
    expect(ordinary?.seriesIndex).toBeUndefined();
    expect(ordinary?.seriesCount).toBeUndefined();
  });
});
