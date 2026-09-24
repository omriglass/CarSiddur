import { describe, expect, it } from "vitest";

import { fleetKeys } from "./queryKeys";

describe("fleetKeys", () => {
  it("carries the department id in every department-scoped key so caches never leak across departments", () => {
    expect(fleetKeys.cars("dept-1")).toEqual(["fleet", "cars", "dept-1"]);
    expect(fleetKeys.seatConfigs("dept-1")).toEqual(["fleet", "seatConfigs", "dept-1"]);
    expect(fleetKeys.turnaroundMinutes("dept-1")).toEqual(["fleet", "turnaroundMinutes", "dept-1"]);
    expect(fleetKeys.maintenanceBlocks("dept-1")).toEqual(["fleet", "maintenanceBlocks", "dept-1"]);
  });

  it("produces distinct keys per department for the same table", () => {
    expect(fleetKeys.cars("dept-1")).not.toEqual(fleetKeys.cars("dept-2"));
  });

  it("keeps `undefined` department distinguishable from a real id (disabled-query placeholder)", () => {
    expect(fleetKeys.cars(undefined)).toEqual(["fleet", "cars", undefined]);
  });

  it("destinations/rideTypes have no department dimension of their own — hooks append it manually (`[...fleetKeys.destinations(), departmentId]`)", () => {
    expect(fleetKeys.destinations()).toEqual(["fleet", "destinations"]);
    expect(fleetKeys.rideTypes()).toEqual(["fleet", "rideTypes"]);
  });

  it("scopes myTemporaryCars by owner id", () => {
    expect(fleetKeys.myTemporaryCars("owner-1")).toEqual(["fleet", "myTemporaryCars", "owner-1"]);
    expect(fleetKeys.myTemporaryCars("owner-1")).not.toEqual(fleetKeys.myTemporaryCars("owner-2"));
  });
});
