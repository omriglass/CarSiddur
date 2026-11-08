import { describe, expect, it } from "vitest";

import type { MakeRoomParty } from "./api";
import { askedOf, defaultCuts, makeRoomChoices, makeRoomNames } from "./makeRoom";

const party = (over: Partial<MakeRoomParty> = {}): MakeRoomParty => ({
  ride_id: "r1", driver_id: "d1", name: "נגה", phone: null,
  starts_at: "2026-11-14T07:30:00.000Z", ends_at: "2026-11-14T15:00:00.000Z",
  end_option: null, start_option: null, askable: true, ...over,
});

describe("makeRoomChoices (REQ §13.203 b)", () => {
  it("offers the smaller shortening first and giving up last", () => {
    const choices = makeRoomChoices(party({ end_option: "2026-11-14T13:00:00.000Z", start_option: "2026-11-14T08:00:00.000Z" }));
    expect(choices.map((c) => [c.cut, c.minutes])).toEqual([["start", 30], ["end", 120], ["cancel", 450]]);
  });

  it("only giving up when no shorter ride is left", () => {
    expect(makeRoomChoices(party()).map((c) => c.cut)).toEqual(["cancel"]);
  });

  it("pre-selects the smallest change per ride", () => {
    expect(defaultCuts([party({ end_option: "2026-11-14T14:30:00.000Z" }), party({ ride_id: "r2" })])).toEqual({ r1: "end", r2: "cancel" });
  });

  it("names each driver once", () => {
    expect(makeRoomNames([party(), party({ ride_id: "r2" }), party({ ride_id: "r3", name: "דן" })])).toBe("נגה, דן");
  });
});

describe("askedOf (REQ §13.203 c)", () => {
  const ride = { starts_at: "2026-11-14T07:30:00.000Z", ends_at: "2026-11-14T15:00:00.000Z" };
  const base = { id: "p", change_id: "c", ride_id: "r1", profile_id: "d1", expected_version: 1, accepted: null, responded_at: null,
    created_at: "", updated_at: "", version: 1, new_starts_at: null, new_ends_at: null, cut: null };

  it("asks to return earlier, with the minutes and the new time", () => {
    const asked = askedOf({ ...base, cut: "end", new_ends_at: "2026-11-14T14:30:00.000Z" }, ride);
    expect(asked.accept).toBe("rideEditing.acceptEnd");
    expect(asked.vars).toMatchObject({ newTime: "16:30", oldTime: "17:00", minutes: "30" });
  });

  it("asks to leave later", () => {
    const asked = askedOf({ ...base, cut: "start", new_starts_at: "2026-11-14T08:30:00.000Z" }, ride);
    expect(asked.accept).toBe("rideEditing.acceptStart");
    expect(asked.vars).toMatchObject({ newTime: "10:30", oldTime: "09:30", minutes: "60" });
  });

  it("an older request (no cut) still asks to give the ride up", () => {
    expect(askedOf(base, ride).accept).toBe("rideEditing.accept");
  });
});
