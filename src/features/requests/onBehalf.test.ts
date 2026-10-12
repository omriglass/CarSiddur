import { describe, expect, it } from "vitest";

import { pickOnBehalfRequester, splitWho } from "./onBehalf";

const members = [
  { id: "a", doesNotDrive: true },
  { id: "b", doesNotDrive: false },
  { id: "c", doesNotDrive: false },
];

describe("pickOnBehalfRequester", () => {
  it("takes the first selected member who drives", () => {
    expect(pickOnBehalfRequester(["a", "c", "b"], members)).toBe("c");
  });
  it("falls back to the first selected member when nobody drives", () => {
    expect(pickOnBehalfRequester(["a"], members)).toBe("a");
  });
  it("is null with nobody selected", () => {
    expect(pickOnBehalfRequester([], members)).toBeNull();
  });
});

describe("splitWho", () => {
  it("keeps everything while 'me' is on", () => {
    expect(splitWho({ companions: ["a", "b"] }, members)).toEqual({ requesterId: null, companions: ["a", "b"] });
    expect(splitWho({ includeMe: true, companions: ["a"] }, members)).toEqual({ requesterId: null, companions: ["a"] });
  });
  it("moves the requester out of the companions", () => {
    expect(splitWho({ includeMe: false, companions: ["a", "b", "c"] }, members)).toEqual({ requesterId: "b", companions: ["a", "c"] });
  });
});
