import { describe, expect, it } from "vitest";

import { applyCarChoice, carChoiceOf, flexBrief, hasCarAndLuggage, invalidTargetOf, isStageOneField, joinNames, joinWho, mergeFlex, sharedFlexValue, unnamedWhoLabel } from "./sentenceModel";

describe("flexibility chips", () => {
  it("shares one value only when earlier and later agree", () => {
    expect(sharedFlexValue(30, 30)).toBe(30);
    expect(sharedFlexValue(30, 0)).toBeNull();
  });

  it("summarises for the sentence chip", () => {
    expect(flexBrief(0, 0)).toEqual({ kind: "none" });
    expect(flexBrief(30, 30)).toEqual({ kind: "both", value: 30 });
    expect(flexBrief("any", "any")).toEqual({ kind: "both", value: "any" });
    expect(flexBrief(60, 0)).toEqual({ kind: "split", early: 60, late: 0 });
  });
});

describe("mergeFlex", () => {
  it("collapses split values to the larger one, any wins", () => {
    expect(mergeFlex(30, 60)).toBe(60);
    expect(mergeFlex(0, 15)).toBe(15);
    expect(mergeFlex("any", 15)).toBe("any");
  });
});

describe("car choice", () => {
  it("derives one radio value from the two classic fields", () => {
    expect(carChoiceOf({ luggage: false, preferredCarId: "" })).toBe("any");
    expect(carChoiceOf({ luggage: true, preferredCarId: "" })).toBe("luggage");
    expect(carChoiceOf({ luggage: false, preferredCarId: "c1" })).toBe("specific");
    expect(carChoiceOf({ luggage: true, preferredCarId: "c1" })).toBe("specific");
    expect(hasCarAndLuggage({ luggage: true, preferredCarId: "c1" })).toBe(true);
  });

  it("keeps both values when a request has both and the member stays on 'specific'", () => {
    expect(applyCarChoice("specific", { luggage: true, preferredCarId: "c1" })).toEqual({ luggage: true, preferredCarId: "c1", preferSpecificCar: true });
  });

  it("'any' and 'luggage' clear the preferred car; 'specific' preselects nothing (R9U6)", () => {
    expect(applyCarChoice("any", { luggage: true, preferredCarId: "c1" })).toEqual({ luggage: false, preferredCarId: "", preferSpecificCar: false });
    expect(applyCarChoice("luggage", { luggage: false, preferredCarId: "c1" })).toEqual({ luggage: true, preferredCarId: "", preferSpecificCar: false });
    expect(applyCarChoice("specific", { luggage: false, preferredCarId: "" })).toEqual({ luggage: false, preferredCarId: "", preferSpecificCar: true });
  });

  it("an empty 'specific' choice stays on the specific radio", () => {
    expect(carChoiceOf({ luggage: false, preferredCarId: "", preferSpecificCar: true })).toBe("specific");
  });
});

describe("invalidTargetOf", () => {
  it("maps rhf field names to the sheet or row that fixes them", () => {
    expect(invalidTargetOf("destination")).toEqual({ kind: "sheet", sheet: "destination" });
    expect(invalidTargetOf("returnTime")).toEqual({ kind: "sheet", sheet: "return" });
    expect(invalidTargetOf("guestNames")).toEqual({ kind: "sheet", sheet: "who" });
    expect(invalidTargetOf("rideTypeId")).toEqual({ kind: "stage2" });
    expect(invalidTargetOf("notes")).toEqual({ kind: "row", row: "notes" });
    expect(invalidTargetOf("rideDescription")).toEqual({ kind: "row", row: "description" });
    expect(invalidTargetOf("nothing")).toBeNull();
  });
});

describe("isStageOneField", () => {
  it("separates the sentence's fields from stage 2's", () => {
    expect(isStageOneField("destination")).toBe(true);
    expect(isStageOneField("guestNames")).toBe(true);
    expect(isStageOneField("rideTypeId")).toBe(false);
    expect(isStageOneField("notes")).toBe(true);
    expect(isStageOneField("preferredCarId")).toBe(false);
  });
});

describe("joinNames", () => {
  it("lists one, two and three names with the conjunction attached to the last", () => {
    expect(joinNames([], "&")).toBe("");
    expect(joinNames(["A"], "&")).toBe("A");
    expect(joinNames(["A", "B"], "&")).toBe("A &B");
    expect(joinNames(["A", "B", "C"], "&")).toBe("A, B &C");
  });

  it("drops blank names", () => {
    expect(joinNames(["A", " ", "B"], "&")).toBe("A &B");
  });
});

describe("joinWho (unnamed adults)", () => {
  it("is joinNames without extras", () => {
    expect(joinWho(["A", "B"], "&", null)).toBe("A &B");
  });
  it("appends the 'and N more' tail to one or several names", () => {
    expect(joinWho(["A"], "&", "+2")).toBe("A &+2");
    expect(joinWho(["A", "B"], "&", "+1")).toBe("A, B &+1");
  });
  it("is just the tail when there are no names", () => {
    expect(joinWho([], "&", "+2")).toBe("+2");
  });
});

describe("unnamedWhoLabel / joinWho with unnamed children (REQ §13.112 d)", () => {
  const labels = {
    adultOne: "more adult",
    adultMany: (n: number) => `more ${n}`,
    moreChildOne: "more child",
    childOne: "child",
    childMany: (n: number) => `${n} children`,
    and: "&",
    andNumber: "&-",
  };
  it("is null without unnamed people", () => {
    expect(unnamedWhoLabel(0, 0, labels)).toBeNull();
  });
  it("keeps the adults-only wording", () => {
    expect(unnamedWhoLabel(1, 0, labels)).toBe("more adult");
    expect(unnamedWhoLabel(3, 0, labels)).toBe("more 3");
  });
  it("says 'more child' for one unnamed child and 'N children' for several", () => {
    expect(unnamedWhoLabel(0, 1, labels)).toBe("more child");
    expect(unnamedWhoLabel(0, 2, labels)).toBe("2 children");
  });
  it("joins adults and children with the conjunction, a maqaf before a number", () => {
    expect(unnamedWhoLabel(1, 1, labels)).toBe("more adult &child");
    expect(unnamedWhoLabel(2, 2, labels)).toBe("more 2 &-2 children");
  });
  it("reads as the who chip: names, then the tail", () => {
    expect(joinWho(["I", "Dana"], "&", unnamedWhoLabel(0, 2, labels), "&-")).toBe("I, Dana &-2 children");
    expect(joinWho(["I"], "&", unnamedWhoLabel(0, 1, labels), "&-")).toBe("I &more child");
  });
  it("routes the unnamed-children fields to the who sheet", () => {
    expect(invalidTargetOf("legacyChildSeats")).toEqual({ kind: "sheet", sheet: "who" });
    expect(invalidTargetOf("boosters")).toEqual({ kind: "sheet", sheet: "who" });
    expect(isStageOneField("legacyChildSeats")).toBe(true);
    expect(invalidTargetOf("windowEnd")).toEqual({ kind: "sheet", sheet: "windowEnd" });
  });
});
