import { describe, expect, it, vi } from "vitest";

import { AppError } from "@/lib/rpc";

const mocks = vi.hoisted(() => ({ from: vi.fn(), rpc: vi.fn() }));

vi.mock("@/integrations/supabase/client", () => ({ supabase: { from: mocks.from } }));
vi.mock("@/lib/rpc", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/rpc")>();
  return { ...actual, rpc: mocks.rpc };
});

import {
  createCarMaintenance,
  deleteCarMaintenance,
  markIssueUnsafeMaintenance,
  updateCarMaintenance,
  fetchCars,
  fetchCarSeatConfigs,
  fetchDestinations,
  fetchMaintenanceBlocks,
  fetchMyTemporaryCars,
  fetchRideTypes,
  fetchTurnaroundMinutes,
  registerTemporaryCar,
  suggestDestination,
} from "./api";

/**
 * `supabase.from(table)` returns a Postgrest query builder that is itself
 * `PromiseLike` (its filter methods all return `this`, `await` resolves via
 * `.then`) — this stub reproduces just enough of that shape for `fleet/api.ts`'s
 * chains (`select/eq/neq/order/insert/single`), while recording every call
 * for assertions.
 */
function makeBuilder(result: { data?: unknown; error?: unknown }) {
  const calls: Record<string, unknown[][]> = {};
  const record = (name: string) => (...args: unknown[]) => {
    (calls[name] ??= []).push(args);
    return builder;
  };
  const builder: Record<string, unknown> = {
    select: vi.fn(record("select")),
    eq: vi.fn(record("eq")),
    neq: vi.fn(record("neq")),
    order: vi.fn(record("order")),
    insert: vi.fn(record("insert")),
    single: vi.fn(() => Promise.resolve(result)),
    then: (onFulfilled: (value: typeof result) => unknown, onRejected?: (reason: unknown) => unknown) =>
      Promise.resolve(result).then(onFulfilled, onRejected),
  };
  return { builder, calls };
}

describe("fetchCars", () => {
  it("scopes to the department and excludes retired cars, flattening an embedded codes object", async () => {
    const { builder, calls } = makeBuilder({
      data: [{ id: "car-1", codes: { access_code: "1234", is_replaced: true, replacement_code: "5678" } }],
      error: null,
    });
    mocks.from.mockReturnValue(builder);
    const cars = await fetchCars("dept-1");
    expect(mocks.from).toHaveBeenCalledWith("cars");
    expect(calls.eq).toEqual([["department_id", "dept-1"]]);
    expect(calls.neq).toEqual([["status", "retired"]]);
    expect(cars).toEqual([{ id: "car-1", access_code: "1234", is_replaced: true, replacement_code: "5678" }]);
  });

  it("takes the first element when codes come back as an array", async () => {
    const { builder } = makeBuilder({
      data: [{ id: "car-1", codes: [{ access_code: "1111", is_replaced: false, replacement_code: null }] }],
      error: null,
    });
    mocks.from.mockReturnValue(builder);
    const [car] = await fetchCars("dept-1");
    expect(car).toMatchObject({ access_code: "1111", is_replaced: false, replacement_code: null });
  });

  it("defaults codes to null/false when no access-code row exists", async () => {
    const { builder } = makeBuilder({ data: [{ id: "car-1", codes: null }], error: null });
    mocks.from.mockReturnValue(builder);
    const [car] = await fetchCars("dept-1");
    expect(car).toMatchObject({ access_code: null, is_replaced: false, replacement_code: null });
  });

  it("returns an empty array when data is null", async () => {
    const { builder } = makeBuilder({ data: null, error: null });
    mocks.from.mockReturnValue(builder);
    expect(await fetchCars("dept-1")).toEqual([]);
  });

  it("throws a mapped AppError on a Postgrest error", async () => {
    const { builder } = makeBuilder({ data: null, error: { message: "not_authorized" } });
    mocks.from.mockReturnValue(builder);
    await expect(fetchCars("dept-1")).rejects.toMatchObject({ code: "not_authorized" });
    await expect(fetchCars("dept-1")).rejects.toBeInstanceOf(AppError);
  });
});

describe("fetchDestinations", () => {
  it("filters to the department's approved destinations, ordered by name", async () => {
    const { builder, calls } = makeBuilder({ data: [{ id: "dest-1", name: "A" }], error: null });
    mocks.from.mockReturnValue(builder);
    const result = await fetchDestinations("dept-1");
    expect(mocks.from).toHaveBeenCalledWith("destinations");
    expect(calls.eq).toEqual([["department_id", "dept-1"], ["is_approved", true]]);
    expect(calls.order).toEqual([["name", { ascending: true }]]);
    expect(result).toEqual([{ id: "dest-1", name: "A" }]);
  });

  it("returns an empty array when data is null", async () => {
    mocks.from.mockReturnValue(makeBuilder({ data: null, error: null }).builder);
    expect(await fetchDestinations("dept-1")).toEqual([]);
  });
});

describe("fetchRideTypes", () => {
  it("filters to the department's active ride types, ordered by sort_order", async () => {
    const { builder, calls } = makeBuilder({ data: [{ id: "type-1" }], error: null });
    mocks.from.mockReturnValue(builder);
    const result = await fetchRideTypes("dept-1");
    expect(mocks.from).toHaveBeenCalledWith("ride_types");
    expect(calls.eq).toEqual([["department_id", "dept-1"], ["is_active", true]]);
    expect(calls.order).toEqual([["sort_order", { ascending: true }]]);
    expect(result).toEqual([{ id: "type-1" }]);
  });
});

describe("fetchCarSeatConfigs", () => {
  it("scopes to the department's active cars via the inner join and strips the embedded car", async () => {
    const { builder, calls } = makeBuilder({
      data: [{ car_id: "car-1", adults: 4, car: { department_id: "dept-1", status: "active" } }],
      error: null,
    });
    mocks.from.mockReturnValue(builder);
    const result = await fetchCarSeatConfigs("dept-1");
    expect(calls.eq).toEqual([["car.department_id", "dept-1"], ["car.status", "active"]]);
    expect(result).toEqual([{ car_id: "car-1", adults: 4 }]);
  });
});

describe("fetchTurnaroundMinutes", () => {
  it("returns the department's turnaround minutes", async () => {
    mocks.from.mockReturnValue(makeBuilder({ data: { turnaround_minutes: 30 }, error: null }).builder);
    expect(await fetchTurnaroundMinutes("dept-1")).toBe(30);
  });

  it("throws a mapped AppError on failure", async () => {
    mocks.from.mockReturnValue(makeBuilder({ data: null, error: { code: "23514" } }).builder);
    await expect(fetchTurnaroundMinutes("dept-1")).rejects.toMatchObject({ code: "constraint_violation" });
  });
});

describe("fetchMaintenanceBlocks", () => {
  it("scopes to the department and returns [] when data is null", async () => {
    const { builder, calls } = makeBuilder({ data: null, error: null });
    mocks.from.mockReturnValue(builder);
    expect(await fetchMaintenanceBlocks("dept-1")).toEqual([]);
    expect(calls.eq).toEqual([["department_id", "dept-1"]]);
  });
});

describe("scheduled maintenance RPCs (REQ §13.114)", () => {
  it("create passes car, period and optional reason", async () => {
    mocks.rpc.mockResolvedValueOnce("block-1");
    expect(await createCarMaintenance({ carId: "car-1", startsAt: "2026-11-12T08:00:00Z", endsAt: "2026-11-12T17:00:00Z" })).toBe("block-1");
    expect(mocks.rpc).toHaveBeenLastCalledWith("create_car_maintenance", { p_car_id: "car-1", p_starts_at: "2026-11-12T08:00:00Z", p_ends_at: "2026-11-12T17:00:00Z", p_reason: undefined });
  });
  it("update returns how many rides the server flagged", async () => {
    mocks.rpc.mockResolvedValueOnce({ id: "b", flagged_rides: 2 });
    expect(await updateCarMaintenance({ blockId: "b", startsAt: "s", endsAt: "e" })).toEqual({ flagged_rides: 2 });
    mocks.rpc.mockResolvedValueOnce(null);
    expect(await updateCarMaintenance({ blockId: "b", startsAt: "s", endsAt: "e" })).toEqual({ flagged_rides: 0 });
  });
  it("delete and the unsafe-issue entry point call their RPCs", async () => {
    mocks.rpc.mockResolvedValueOnce(null);
    await deleteCarMaintenance("b");
    expect(mocks.rpc).toHaveBeenLastCalledWith("delete_car_maintenance", { p_block_id: "b" });
    mocks.rpc.mockResolvedValueOnce("b2");
    await markIssueUnsafeMaintenance({ issueId: "i", endsAt: "e" });
    expect(mocks.rpc).toHaveBeenLastCalledWith("report_car_issue_unsafe_maintenance", { p_issue_id: "i", p_ends_at: "e" });
  });
});

describe("fetchMyTemporaryCars", () => {
  it("filters to the owner's temporary cars", async () => {
    const { builder, calls } = makeBuilder({ data: [{ id: "car-1", type: "temporary" }], error: null });
    mocks.from.mockReturnValue(builder);
    const result = await fetchMyTemporaryCars("owner-1");
    expect(calls.eq).toEqual([["owner_id", "owner-1"], ["type", "temporary"]]);
    expect(result).toEqual([{ id: "car-1", type: "temporary" }]);
  });
});

describe("registerTemporaryCar", () => {
  const input = {
    departmentId: "dept-1",
    ownerId: "owner-1",
    name: "My Car",
    licensePlate: "12-345-67",
    seatConfig: { adults: 4, childSeats: 1, boosters: 0 },
  };

  it("inserts the car row, then its seat config, and returns the car", async () => {
    const car = { id: "car-1", department_id: "dept-1", owner_id: "owner-1" };
    const { builder: carBuilder } = makeBuilder({ data: car, error: null });
    const { builder: seatBuilder, calls: seatCalls } = makeBuilder({ data: null, error: null });
    mocks.from.mockImplementation((table: string) => (table === "cars" ? carBuilder : seatBuilder));

    const result = await registerTemporaryCar(input);

    expect(result).toEqual(car);
    expect(carBuilder.insert).toHaveBeenCalledWith(
      expect.objectContaining({ department_id: "dept-1", owner_id: "owner-1", type: "temporary", status: "active" }),
    );
    expect(seatCalls.insert).toEqual([[{ car_id: "car-1", adults: 4, child_seats: 1, boosters: 0 }]]);
  });

  it("throws and never attempts the seat-config insert when the car insert fails", async () => {
    const { builder: carBuilder } = makeBuilder({ data: null, error: { message: "not_authorized" } });
    const { builder: seatBuilder } = makeBuilder({ data: null, error: null });
    mocks.from.mockImplementation((table: string) => (table === "cars" ? carBuilder : seatBuilder));

    await expect(registerTemporaryCar(input)).rejects.toMatchObject({ code: "not_authorized" });
    expect(seatBuilder.insert).not.toHaveBeenCalled();
  });
});

describe("suggestDestination", () => {
  it("forwards the department, name and a default zone to the RPC", async () => {
    mocks.rpc.mockResolvedValue("destination-id");
    const result = await suggestDestination("dept-1", "New place");
    expect(mocks.rpc).toHaveBeenCalledWith("suggest_destination", {
      p_department_id: "dept-1",
      p_name: "New place",
      p_zone: "unknown",
    });
    expect(result).toBe("destination-id");
  });

  it("forwards an explicit zone", async () => {
    mocks.rpc.mockResolvedValue("destination-id");
    await suggestDestination("dept-1", "New place", "north");
    expect(mocks.rpc).toHaveBeenCalledWith("suggest_destination", {
      p_department_id: "dept-1",
      p_name: "New place",
      p_zone: "north",
    });
  });
});
