import { afterEach, describe, expect, it } from "vitest";
import { dragHintCounter, EDIT_MODE_IDLE_MS, expireEditMode, isEditMode, noteEditModeActivity, setEditMode } from "./editMode";

afterEach(() => setEditMode(false));

describe("edit mode (owner 2026-10-30)", () => {
  it("is off until turned on, and turns itself off after five untouched minutes", () => {
    expect(isEditMode()).toBe(false);
    setEditMode(true, 1_000);
    expect(isEditMode()).toBe(true);
    noteEditModeActivity(1_000 + EDIT_MODE_IDLE_MS - 1);
    expect(expireEditMode(1_000 + EDIT_MODE_IDLE_MS)).toBe(false);
    expect(isEditMode()).toBe(true);
    expect(expireEditMode(1_000 + 2 * EDIT_MODE_IDLE_MS)).toBe(true);
    expect(isEditMode()).toBe(false);
  });
});

describe("drag hints", () => {
  it("one attempt is not a hint; a second within the window is, then quiet for a while", () => {
    const counter = dragHintCounter();
    expect(counter.attempt("locked", 0)).toBeNull();
    expect(counter.attempt("locked", 5_000)).toBe("locked");
    expect(counter.attempt("locked", 6_000)).toBeNull();
    expect(counter.attempt("notYours", 7_000)).toBeNull();
    expect(counter.attempt("notYours", 30_000)).toBeNull();
    expect(counter.attempt("notYours", 31_000)).toBe("notYours");
  });
  it("attempts far apart are not repeated attempts", () => {
    const counter = dragHintCounter();
    expect(counter.attempt("locked", 0)).toBeNull();
    expect(counter.attempt("locked", 60_000)).toBeNull();
  });
});
