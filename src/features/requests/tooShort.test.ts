import { describe, expect, it } from "vitest";
import { roundTripTooShort } from "./tooShort";

const base = { tripType: "round_trip", departTime: "09:00", returnTime: "09:45", outMinutes: 70, returnMinutes: 75 };

describe("roundTripTooShort", () => {
  it("warns when the window is shorter than the drive there and back (R13B16: 45 minutes to Tel Aviv)", () => {
    expect(roundTripTooShort(base)).toBe(145);
  });
  it("is quiet when the window covers both drives", () => {
    expect(roundTripTooShort({ ...base, returnTime: "11:25" })).toBeNull();
    expect(roundTripTooShort({ ...base, returnTime: "12:00" })).toBeNull();
  });
  it("is quiet until both drives are known", () => {
    expect(roundTripTooShort({ ...base, returnMinutes: null })).toBeNull();
  });
  it("only applies to a round trip", () => {
    expect(roundTripTooShort({ ...base, tripType: "drop_off" })).toBeNull();
    expect(roundTripTooShort({ ...base, tripType: "one_way" })).toBeNull();
  });
  it("leaves a return before the departure to the form's own time check", () => {
    expect(roundTripTooShort({ ...base, returnTime: "08:00" })).toBeNull();
  });
});
