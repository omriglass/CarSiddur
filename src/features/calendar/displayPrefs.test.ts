// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";

import { DEFAULT_DISPLAY_PREFS, readDisplayPrefs, writeDisplayPrefs } from "./displayPrefs";

describe("calendar display prefs (per device)", () => {
  afterEach(() => localStorage.clear());

  it("defaults: hours + location, sky tint, rides fully opaque", () => {
    expect(readDisplayPrefs()).toEqual(DEFAULT_DISPLAY_PREFS);
    expect(DEFAULT_DISPLAY_PREFS).toMatchObject({ hours: true, location: true, participants: false, notes: false, useCalendarColors: false, itemVisibility: 50 });
  });

  it("round-trips, and clamps the visibility aid to 0–100 (50 when missing)", () => {
    writeDisplayPrefs({ ...DEFAULT_DISPLAY_PREFS, notes: true, itemVisibility: 80 });
    expect(readDisplayPrefs()).toMatchObject({ notes: true, itemVisibility: 80 });
    localStorage.setItem("calendar.display.v1", JSON.stringify({ itemVisibility: 400 }));
    expect(readDisplayPrefs().itemVisibility).toBe(100);
    localStorage.setItem("calendar.display.v1", JSON.stringify({ itemOpacity: 0.5 }));
    expect(readDisplayPrefs().itemVisibility).toBe(50);
  });
});
