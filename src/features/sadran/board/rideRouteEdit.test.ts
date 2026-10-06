import { describe, expect, it } from "vitest";

import { initialRouteEditValues, reservationRoutePlaces, routeEditChanged, routeEditPayload, stopEqualsDestination, type RouteEditValues } from "./rideRouteEdit";

const base: RouteEditValues = {
  origin: { presetId: "home", name: "Home" },
  destination: { presetId: "haifa", name: "Haifa" },
  outStops: [{ presetId: "s1", name: "S1" }],
  returnStops: [],
};

describe("routeEditPayload", () => {
  it("carries places and the whole stop set per leg in route order", () => {
    const payload = routeEditPayload("ride1", { ...base, destination: { freeText: " Clinic " }, returnStops: [{ freeText: "Kiosk" }] });
    expect(payload).toEqual({
      ride_id: "ride1", origin_id: "home", destination_text: "Clinic",
      stops: [{ leg: "out", place_id: "s1" }, { leg: "return", place_text: "Kiosk" }],
    });
  });
  it("sends an empty stops array when all stops were removed (it replaces the set)", () => {
    expect(routeEditPayload("r", { ...base, outStops: [] }).stops).toEqual([]);
  });
});

describe("routeEditChanged", () => {
  it("detects a changed place, stop or order only", () => {
    expect(routeEditChanged(base, { ...base })).toBe(false);
    expect(routeEditChanged(base, { ...base, origin: { presetId: "other", name: "O" } })).toBe(true);
    expect(routeEditChanged(base, { ...base, outStops: [] })).toBe(true);
    expect(routeEditChanged(base, { ...base, destination: { presetId: "haifa", name: "Renamed" } })).toBe(false);
  });
});

describe("reservationRoutePlaces", () => {
  it("needs two list places", () => {
    expect(reservationRoutePlaces(base)).toEqual({ originId: "home", destinationId: "haifa" });
    expect(reservationRoutePlaces({ ...base, destination: { freeText: "x" } })).toBeNull();
    expect(reservationRoutePlaces({ ...base, origin: null })).toBeNull();
  });
});

describe("initialRouteEditValues", () => {
  const ride = { origin_id: "home", origin_name: "Home", destination_id: "haifa", destination_name: "Haifa" };
  const request = { origin_id: null, origin_text: null, origin_resolved_name: null, destination_id: "haifa", destination_text: null, destination_resolved_name: "Haifa", trip_shape: "round_trip" };
  const placeName = (id: string) => ({ home: "Home" })[id as "home"];

  it("starts from the request's route, the home as the implicit origin, and its stops per leg", () => {
    const values = initialRouteEditValues({
      request, ride, homeId: "home", placeName,
      stops: [
        { leg: "return", position: 0, place_id: null, place_text: "Kiosk", name: "Kiosk" },
        { leg: "out", position: 1, place_id: "s2", place_text: null, name: "S2" },
        { leg: "out", position: 0, place_id: "s1", place_text: null, name: "S1" },
      ],
    });
    expect(values.origin).toEqual({ presetId: "home", name: "Home" });
    expect(values.destination).toEqual({ presetId: "haifa", name: "Haifa" });
    expect(values.outStops.map((v) => ("presetId" in v ? v.presetId : v.freeText))).toEqual(["s1", "s2"]);
    expect(values.returnStops).toEqual([{ freeText: "Kiosk" }]);
  });

  it("keeps (inactive) return stops for a one-way request (REQ §13.97) and uses the ride's places for a reservation", () => {
    const oneWay = initialRouteEditValues({ request: { ...request, trip_shape: "one_way_to" }, ride, homeId: "home", placeName, stops: [{ leg: "return", position: 0, place_id: "x", place_text: null, name: "X" }] });
    expect(oneWay.returnStops).toEqual([{ presetId: "x", name: "X" }]);
    const reservation = initialRouteEditValues({ request: null, ride, placeName, stops: [] });
    expect(reservation).toMatchObject({ origin: { presetId: "home" }, destination: { presetId: "haifa" }, outStops: [] });
  });
});

describe("stopEqualsDestination (R3B21)", () => {
  const dest = { presetId: "d1", name: "x" };
  it("flags a return stop equal to the destination", () => {
    expect(stopEqualsDestination({ origin: null, destination: dest, outStops: [], returnStops: [{ presetId: "d1", name: "x" }] })).toBe(true);
    expect(stopEqualsDestination({ origin: null, destination: dest, outStops: [], returnStops: [{ presetId: "d2", name: "y" }] })).toBe(false);
  });
});
