import { describe, expect, it } from "vitest";

import { joinPeopleInputs } from "./joinPeople";

const members = [{ id: "omer", name: "Omer" }, { id: "aviv", name: "Aviv" }];
const base = { childIds: [], guestNames: "", members, children: [] };

describe("joinPeopleInputs (DP1-1)", () => {
  it("someone else's request joins with its requester and companions, never the editor", () => {
    const out = joinPeopleInputs({ ...base, requester: { id: "eli", name: "Eli" }, requesterRides: true, companionIds: ["omer"] });
    expect(out.map((p) => p.person_id)).toEqual(["eli", "omer"]);
    expect(out[0]).toMatchObject({ display_name: "Eli", seat_kind: "adult" });
  });

  it("my own new request joins with me", () => {
    const out = joinPeopleInputs({ ...base, requester: { id: "me", name: "Me" }, requesterRides: true, companionIds: [] });
    expect(out.map((p) => p.person_id)).toEqual(["me"]);
  });

  it("a ride filed for someone else without me joins with the named people only", () => {
    const out = joinPeopleInputs({ ...base, requester: { id: "me", name: "Me" }, requesterRides: false, companionIds: ["aviv", "omer"] });
    expect(out.map((p) => p.person_id)).toEqual(["aviv", "omer"]);
  });

  it("each person once", () => {
    const out = joinPeopleInputs({ ...base, requester: { id: "omer", name: "Omer" }, requesterRides: true, companionIds: ["omer", "aviv", "aviv"] });
    expect(out.map((p) => p.person_id)).toEqual(["omer", "aviv"]);
  });
});
