// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest";

import { clearStoredCalendarToken, readStoredCalendarToken, writeStoredCalendarToken } from "./storedToken";

const NOW = 1_800_000_000_000;

/** Owner 2026-10-22: the calendar token survives a reload on this device until it expires. */
describe("stored calendar token", () => {
  beforeEach(() => localStorage.clear());

  it("comes back for the same user while it is valid", () => {
    writeStoredCalendarToken({ token: "t1", expiresAt: NOW + 30 * 60_000, userId: "u1" });
    expect(readStoredCalendarToken("u1", NOW)).toBe("t1");
  });

  it("is dropped for another user, near expiry, or after clearing", () => {
    writeStoredCalendarToken({ token: "t1", expiresAt: NOW + 30 * 60_000, userId: "u1" });
    expect(readStoredCalendarToken("u2", NOW)).toBeNull();
    expect(readStoredCalendarToken("u1", NOW)).toBeNull(); // the other user's read removed it

    writeStoredCalendarToken({ token: "t2", expiresAt: NOW + 30_000, userId: "u1" });
    expect(readStoredCalendarToken("u1", NOW)).toBeNull();

    writeStoredCalendarToken({ token: "t3", expiresAt: NOW + 30 * 60_000, userId: "u1" });
    clearStoredCalendarToken();
    expect(readStoredCalendarToken("u1", NOW)).toBeNull();
  });

  it("ignores garbage", () => {
    localStorage.setItem("calendar.token.v1", "{not json");
    expect(readStoredCalendarToken("u1", NOW)).toBeNull();
  });
});
