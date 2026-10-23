import { describe, expect, it } from "vitest";

import { he } from "@/i18n/he";

import type { BoardRide } from "./api";
import { carModeLabel } from "./carModeLine";

const ride = (extra: Partial<BoardRide>) => ({ origin_id: "home", destination_id: "home", driver_id: "driver", is_chauffeur: false, ...extra }) as BoardRide;

describe("carModeLabel (R13U6)", () => {
  it("tells only the driver that the car stays with them", () => {
    expect(carModeLabel(ride({}), "driver")).toBe(he.rideDetail.carModeKeep);
    expect(carModeLabel(ride({}), "passenger")).toBe("");
    expect(carModeLabel(ride({}), undefined)).toBe("");
  });
  it("a chauffeur ride reads the same for everyone; a one-way leg has no line", () => {
    expect(carModeLabel(ride({ is_chauffeur: true }), "passenger")).toBe(he.rideDetail.carModeChauffeur);
    expect(carModeLabel(ride({ destination_id: "x" }), "driver")).toBe("");
  });
});
