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
    // REQUIREMENTS §13.93: a backfilled row always has origin_id set (home by
    // default) and a non-null trip_type; tests override these explicitly.
    origin_id: HOME,
    origin_text: null,
    trip_type: "round_trip",
    one_way_car_mode: null,
    depart_at: "2026-09-08T05:00:00Z",
    return_at: "2026-09-08T10:00:00Z",
    flex_depart_early: "00:15:00",
    flex_depart_late: "0",
    flex_return_early: "0",
    flex_return_late: "1 day",
    duration_locked: false,
    adults: 1,
    child_seats: 0,
    boosters: 0,
    has_luggage: false,
    luggage_waived_at: null,
    luggage_waived_by: null,
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
    base_location_id: null,
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
  stop_minutes: 5,
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

  it("parses any quarter-hour slack of a window request (REQ §13.112 c)", () => {
    expect(parseFlexInterval("03:15:00")).toBe(195);
    expect(parseFlexInterval("11:45:00")).toBe(705);
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
    expect(input.cars[0]).toMatchObject({ id: "car-1", type: "shared", luggageCapacity: 0 });
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

  it("maps requester_does_not_drive to canDrive: false (REQ §88); leaves canDrive undefined otherwise", () => {
    const input = buildSolverInput({
      weekStart: WEEK_START,
      homeDestinationId: HOME,
      departmentSettings: DEFAULT_SETTINGS,
      requests: [
        requestRow({ id: "drives" }),
        { ...requestRow({ id: "non-driver" }), requester_does_not_drive: true },
      ],
      rideTypeCodesById: {},
      cars: [],
      seatConfigsByCarId: {},
      destinations: [destRow()],
      policy: { id: "p1", version: 1, rules: [] },
    });

    const byId = new Map(input.requests.map((r) => [r.id, r]));
    expect(byId.get("drives")!.canDrive).toBeUndefined();
    expect(byId.get("non-driver")!.canDrive).toBe(false);
  });

  it("maps duration_locked to Request.durationLocked (REQ §13.112 c), undefined when off", () => {
    const input = buildSolverInput({
      weekStart: WEEK_START,
      homeDestinationId: HOME,
      departmentSettings: DEFAULT_SETTINGS,
      requests: [
        requestRow({ id: "plain" }),
        { ...requestRow({ id: "window" }), duration_locked: true, flex_depart_early: "0", flex_depart_late: "03:15:00", flex_return_late: "03:15:00" },
      ],
      rideTypeCodesById: {},
      cars: [],
      seatConfigsByCarId: {},
      destinations: [destRow()],
      policy: { id: "p1", version: 1, rules: [] },
    });
    const byId = new Map(input.requests.map((r) => [r.id, r]));
    expect(byId.get("plain")!.durationLocked).toBeUndefined();
    expect(byId.get("window")!.durationLocked).toBe(true);
    expect(byId.get("window")!.flexDeparture).toEqual({ earlierMin: 0, laterMin: 195 });
    expect(byId.get("window")!.flexReturn).toEqual({ earlierMin: 0, laterMin: 195 });
  });

  it("maps driving_companion_ids straight onto Request.drivingCompanionIds, undefined when empty/absent (REQ §13.88)", () => {
    const input = buildSolverInput({
      weekStart: WEEK_START,
      homeDestinationId: HOME,
      departmentSettings: DEFAULT_SETTINGS,
      requests: [
        { ...requestRow({ id: "non-driver-with-driving-companion" }), requester_does_not_drive: true, driving_companion_ids: ["companion-1"] },
        { ...requestRow({ id: "non-driver-no-driving-companion" }), requester_does_not_drive: true, driving_companion_ids: [] },
        requestRow({ id: "driver-field-absent" }),
      ],
      rideTypeCodesById: {},
      cars: [],
      seatConfigsByCarId: {},
      destinations: [destRow()],
      policy: { id: "p1", version: 1, rules: [] },
    });

    const byId = new Map(input.requests.map((r) => [r.id, r]));
    expect(byId.get("non-driver-with-driving-companion")!.drivingCompanionIds).toEqual(["companion-1"]);
    expect(byId.get("non-driver-no-driving-companion")!.drivingCompanionIds).toBeUndefined();
    expect(byId.get("driver-field-absent")!.drivingCompanionIds).toBeUndefined();
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

  it("maps a large-luggage request to luggage:true, and a waived one to luggage:false (REQ §13.111 a)", () => {
    const solverInput = (requests: RequestRow[]) => buildSolverInput({
      weekStart: WEEK_START,
      homeDestinationId: HOME,
      departmentSettings: DEFAULT_SETTINGS,
      requests,
      rideTypeCodesById: { "rt-work": "work" },
      cars: [carRow()],
      seatConfigsByCarId: {},
      destinations: [destRow(), destRow({ id: HOME, name: "נבו", zone: "home", distance_km: null, travel_minutes: null, public_transport_score: null })],
      policy: { id: "p1", version: 1, rules: [] },
    });
    const luggage = (input: ReturnType<typeof solverInput>) => input.requests.map((request) => request.luggage);
    expect(luggage(solverInput([requestRow({ has_luggage: true })]))).toEqual([true]);
    expect(luggage(solverInput([requestRow({ has_luggage: true, luggage_waived_at: "2026-10-17T08:00:00Z" })]))).toEqual([false]);
    expect(luggage(solverInput([requestRow({ has_luggage: false })]))).toEqual([false]);
  });

  it("marks cars (luggageCapacity > 0, no count cap) with the large_trunk feature", () => {
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

    expect(input.cars[0]!.luggageCapacity).toBeGreaterThan(0);
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

describe("origins, trip types, cars stay put (REQUIREMENTS §13.93, docs/ORIGINS_PLAN_2026-10.md §4)", () => {
  it("maps origin_id straight onto Request.originId; originIsFreeText false", () => {
    const input = buildSolverInput({
      weekStart: WEEK_START,
      homeDestinationId: HOME,
      departmentSettings: DEFAULT_SETTINGS,
      requests: [requestRow({ id: "r1", origin_id: "dest-harish", origin_text: null })],
      rideTypeCodesById: {},
      cars: [],
      seatConfigsByCarId: {},
      destinations: [destRow()],
      policy: { id: "p1", version: 1, rules: [] },
    });
    const r = input.requests[0]!;
    expect(r.originId).toBe("dest-harish");
    expect(r.originIsFreeText).toBe(false);
  });

  it("a null origin_id with origin_text set maps to originIsFreeText: true, originId undefined", () => {
    const input = buildSolverInput({
      weekStart: WEEK_START,
      homeDestinationId: HOME,
      departmentSettings: DEFAULT_SETTINGS,
      requests: [requestRow({ id: "r1", origin_id: null, origin_text: "איפשהו בכביש" })],
      rideTypeCodesById: {},
      cars: [],
      seatConfigsByCarId: {},
      destinations: [destRow()],
      policy: { id: "p1", version: 1, rules: [] },
    });
    const r = input.requests[0]!;
    expect(r.originId).toBeUndefined();
    expect(r.originIsFreeText).toBe(true);
  });

  it("maps trip_type straight onto Request.tripType, always explicitly -- a stored 'one_way' is never left to derive from legacy trip_shape", () => {
    const input = buildSolverInput({
      weekStart: WEEK_START,
      homeDestinationId: HOME,
      departmentSettings: DEFAULT_SETTINGS,
      requests: [
        // Legacy trip_shape for a one_way request is 'one_way_to' -- effectiveTripType()
        // would derive 'drop_off' from that alone; trip_type must override it.
        requestRow({ id: "one-way", trip_shape: "one_way_to", trip_type: "one_way", depart_at: "2026-09-08T05:00:00Z", return_at: null }),
        requestRow({ id: "drop-off", trip_shape: "one_way_to", trip_type: "drop_off", depart_at: "2026-09-08T05:00:00Z", return_at: null }),
        requestRow({ id: "round-trip", trip_shape: "round_trip", trip_type: "round_trip" }),
        // A free-text destination can never relay (REQ §13.58): placed as a chauffeur ride.
        requestRow({ id: "one-way-free-text", trip_shape: "one_way_to", trip_type: "one_way", destination_id: null, destination_text: "x", depart_at: "2026-09-08T05:00:00Z", return_at: null }),
      ],
      rideTypeCodesById: {},
      cars: [],
      seatConfigsByCarId: {},
      destinations: [destRow()],
      policy: { id: "p1", version: 1, rules: [] },
    });
    const byId = new Map(input.requests.map((r) => [r.id, r]));
    expect(byId.get("one-way")!.tripType).toBe("one_way");
    expect(byId.get("drop-off")!.tripType).toBe("drop_off");
    expect(byId.get("round-trip")!.tripType).toBe("round_trip");
    expect(byId.get("one-way-free-text")!.tripType).toBe("drop_off");
  });

  it("maps cars.base_location_id onto Car.baseLocationId, undefined when null", () => {
    const input = buildSolverInput({
      weekStart: WEEK_START,
      homeDestinationId: HOME,
      departmentSettings: DEFAULT_SETTINGS,
      requests: [],
      rideTypeCodesById: {},
      cars: [carRow({ id: "car-1", base_location_id: "dest-haifa" }), carRow({ id: "car-2", base_location_id: null })],
      seatConfigsByCarId: {},
      destinations: [destRow()],
      policy: { id: "p1", version: 1, rules: [] },
    });
    const byId = new Map(input.cars.map((c) => [c.id, c]));
    expect(byId.get("car-1")!.baseLocationId).toBe("dest-haifa");
    expect(byId.get("car-2")!.baseLocationId).toBeUndefined();
  });

  it("maps carStartLocationsByCarId onto Car.startLocationId; a car left out of the map is undefined (defaults to home)", () => {
    const input = buildSolverInput({
      weekStart: WEEK_START,
      homeDestinationId: HOME,
      departmentSettings: DEFAULT_SETTINGS,
      requests: [],
      rideTypeCodesById: {},
      cars: [carRow({ id: "car-1" }), carRow({ id: "car-2" })],
      seatConfigsByCarId: {},
      destinations: [destRow()],
      policy: { id: "p1", version: 1, rules: [] },
      carStartLocationsByCarId: { "car-1": { locationId: "dest-haifa", baseLocationId: HOME } },
    });
    const byId = new Map(input.cars.map((c) => [c.id, c]));
    expect(byId.get("car-1")!.startLocationId).toBe("dest-haifa");
    expect(byId.get("car-2")!.startLocationId).toBeUndefined();
  });

  it("a temporary car's baseLocationId comes from car_start_locations() (owner's default origin), not undefined", () => {
    const input = buildSolverInput({
      weekStart: WEEK_START,
      homeDestinationId: HOME,
      departmentSettings: DEFAULT_SETTINGS,
      requests: [],
      rideTypeCodesById: {},
      cars: [carRow({ id: "car-1", type: "temporary" } as never), carRow({ id: "car-2" })],
      seatConfigsByCarId: {},
      destinations: [destRow()],
      policy: { id: "p1", version: 1, rules: [] },
      carStartLocationsByCarId: {
        "car-1": { locationId: "dest-haifa", baseLocationId: "dest-haifa" },
        "car-2": { locationId: HOME, baseLocationId: HOME },
      },
    });
    const byId = new Map(input.cars.map((c) => [c.id, c]));
    expect(byId.get("car-1")!.baseLocationId).toBe("dest-haifa");
  });

  it("passes travel through to SolverInput.travel unchanged, [] when omitted", () => {
    const travel = [{ fromId: "dest-haifa", toId: "dest-nahariya", distanceKm: 20, travelMinutes: 25 }];
    const withTravel = buildSolverInput({
      weekStart: WEEK_START, homeDestinationId: HOME, departmentSettings: DEFAULT_SETTINGS,
      requests: [], rideTypeCodesById: {}, cars: [], seatConfigsByCarId: {}, destinations: [],
      policy: { id: "p1", version: 1, rules: [] }, travel,
    });
    expect(withTravel.travel).toBe(travel);

    const withoutTravel = buildSolverInput({
      weekStart: WEEK_START, homeDestinationId: HOME, departmentSettings: DEFAULT_SETTINGS,
      requests: [], rideTypeCodesById: {}, cars: [], seatConfigsByCarId: {}, destinations: [],
      policy: { id: "p1", version: 1, rules: [] },
    });
    expect(withoutTravel.travel).toBeUndefined();
  });

  it("maps department_settings.stop_minutes onto SolverConfig.stopMinutes (REQ §13.93 'Multi-stop rides')", () => {
    const input = buildSolverInput({
      weekStart: WEEK_START, homeDestinationId: HOME, departmentSettings: { ...DEFAULT_SETTINGS, stop_minutes: 7 },
      requests: [], rideTypeCodesById: {}, cars: [], seatConfigsByCarId: {}, destinations: [],
      policy: { id: "p1", version: 1, rules: [] },
    });
    expect(input.config.stopMinutes).toBe(7);
  });

  it("maps request_stops rows onto Request.stops, sorted by position, free-text (no place_id) -> locationId undefined; omitted when empty/absent", () => {
    const input = buildSolverInput({
      weekStart: WEEK_START,
      homeDestinationId: HOME,
      departmentSettings: DEFAULT_SETTINGS,
      requests: [
        {
          ...requestRow({ id: "with-stops" }),
          stops: [
            { leg: "out", position: 2, place_id: "dest-b" },
            { leg: "out", position: 1, place_id: "dest-a" },
            { leg: "return", position: 1, place_id: null },
            { leg: "return", position: 2, place_id: "dest-z", active: false },
          ],
        },
        { ...requestRow({ id: "only-inactive" }), stops: [{ leg: "return", position: 1, place_id: "dest-z", active: false }] },
        requestRow({ id: "no-stops" }),
      ],
      rideTypeCodesById: {},
      cars: [],
      seatConfigsByCarId: {},
      destinations: [destRow()],
      policy: { id: "p1", version: 1, rules: [] },
    });
    const byId = new Map(input.requests.map((r) => [r.id, r]));
    expect(byId.get("with-stops")!.stops).toEqual([
      { leg: "out", locationId: "dest-a" },
      { leg: "out", locationId: "dest-b" },
      { leg: "return", locationId: undefined },
    ]);
    expect(byId.get("no-stops")!.stops).toBeUndefined();
    // REQ §13.97: inactive (dormant return) stops never reach the solver.
    expect(byId.get("only-inactive")!.stops).toBeUndefined();
  });

  describe("fallback / plan B (REQ §13.112 a/b)", () => {
    const build = (requests: Parameters<typeof buildSolverInput>[0]["requests"]) => buildSolverInput({
      weekStart: WEEK_START, homeDestinationId: HOME, departmentSettings: DEFAULT_SETTINGS, requests,
      rideTypeCodesById: {}, cars: [], seatConfigsByCarId: {}, destinations: [destRow()], policy: { id: "p1", version: 1, rules: [] },
    });
    const alt = { drop_place_id: "dest-a", drop_place_text: null, arrive_by: "2026-09-08T05:00:00Z", pickup: true, pickup_at: "2026-09-08T14:00:00Z", applied_at: null };

    it("maps a plan B (list place, with a pickup) onto Request.alternative and the fallback", () => {
      const input = build([{ ...requestRow({ id: "a", fallback: "alternative" } as Partial<RequestRow>), alternative: alt }]);
      const request = input.requests[0]!;
      expect(request.fallback).toBe("alternative");
      expect(request.alternative).toEqual({
        dropPlaceId: "dest-a", dropPlaceIsFreeText: false, dropPlaceText: undefined,
        arriveByMs: Date.parse("2026-09-08T05:00:00Z"), pickupMs: Date.parse("2026-09-08T14:00:00Z"),
      });
    });
    it("a free-text drop place uses the free-text sentinel (and adds it to the destinations); no pickup = no pickupMs", () => {
      const input = build([{ ...requestRow({ id: "a", fallback: "alternative" } as Partial<RequestRow>), alternative: { ...alt, drop_place_id: null, drop_place_text: "the junction", pickup: false, pickup_at: null } }]);
      expect(input.requests[0]!.alternative).toMatchObject({ dropPlaceId: FREE_TEXT_DESTINATION_ID, dropPlaceIsFreeText: true, dropPlaceText: "the junction", pickupMs: undefined });
      expect(input.destinations[FREE_TEXT_DESTINATION_ID]).toBeDefined();
    });
    it("אסתדר maps to fallback manage only", () => {
      const request = build([requestRow({ id: "m", fallback: "manage" } as Partial<RequestRow>)]).requests[0]!;
      expect(request.fallback).toBe("manage");
      expect(request.alternative).toBeUndefined();
    });
    it("no active fallback for a הקפצה (dormant), a series leg, fallback none, or a plan B that was already applied", () => {
      const rows = [
        { ...requestRow({ id: "d", fallback: "alternative", trip_type: "drop_off" } as Partial<RequestRow>), alternative: alt },
        { ...requestRow({ id: "s", fallback: "alternative", series_id: "S", series_index: 1, series_count: 2 } as Partial<RequestRow>), alternative: alt },
        { ...requestRow({ id: "n", fallback: "none" } as Partial<RequestRow>), alternative: alt },
        { ...requestRow({ id: "x", fallback: "alternative", served_by_alternative: true } as Partial<RequestRow>), alternative: { ...alt, applied_at: "2026-09-07T10:00:00Z" } },
      ];
      const byId = new Map(build(rows).requests.map((r) => [r.id, r]));
      for (const id of ["d", "s", "n"]) { expect(byId.get(id)!.fallback).toBeUndefined(); expect(byId.get(id)!.alternative).toBeUndefined(); }
      // a request an accepted plan B serves keeps only the scoring flag
      expect(byId.get("x")!.fallback).toBeUndefined();
      expect(byId.get("x")!.alternative).toBeUndefined();
      expect(byId.get("x")!.servedByAlternative).toBe(true);
    });

    it("maps a pickup from another place and flags the pickup-leg sibling", () => {
      const input = build([
        { ...requestRow({ id: "a", fallback: "alternative" } as Partial<RequestRow>), alternative: { ...alt, pickup_place_id: "dest-b" } },
        requestRow({ id: "s", plan_b_parent_id: "a", served_by_alternative: true, trip_type: "drop_off" } as Partial<RequestRow>),
      ]);
      const byId = new Map(input.requests.map((r) => [r.id, r]));
      expect(byId.get("a")!.alternative).toMatchObject({ pickupPlaceId: "dest-b" });
      expect(byId.get("s")!.planBSibling).toBe(true);
    });
  });
});
