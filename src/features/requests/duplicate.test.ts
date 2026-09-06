import { describe, expect, it } from "vitest";

import { findOverlappingRequest } from "./duplicate";

const existing = [
  { id: "a", departAt: "2026-09-15T06:00:00Z", returnAt: "2026-09-15T10:00:00Z" },
  { id: "b", departAt: "2026-09-16T06:00:00Z", returnAt: null },
  { id: "c", departAt: null, returnAt: "2026-09-17T09:00:00Z" },
];

describe("findOverlappingRequest", () => {
  it("finds an overlapping round-trip window", () => {
    const match = findOverlappingRequest(
      { departAt: "2026-09-15T09:00:00Z", returnAt: "2026-09-15T12:00:00Z" },
      existing,
    );
    expect(match?.id).toBe("a");
  });

  it("returns null when windows are disjoint", () => {
    const match = findOverlappingRequest(
      { departAt: "2026-09-15T11:00:00Z", returnAt: "2026-09-15T15:00:00Z" },
      existing,
    );
    expect(match).toBeNull();
  });

  it("treats touching bounds as overlapping (inclusive range, mirrors SQL '[]')", () => {
    const match = findOverlappingRequest(
      { departAt: "2026-09-15T10:00:00Z", returnAt: "2026-09-15T11:00:00Z" },
      existing,
    );
    expect(match?.id).toBe("a");
  });

  it("excludes the request being edited", () => {
    const match = findOverlappingRequest(
      { departAt: "2026-09-15T09:00:00Z", returnAt: "2026-09-15T12:00:00Z" },
      existing,
      "a",
    );
    expect(match).toBeNull();
  });

  it("matches a one-way (single-instant) request against an identical existing one-way instant", () => {
    // Two zero-width spans only intersect when they land on the exact same instant
    // (mirrors SQL's tstzrange('[]') on two equal points) — a few minutes apart do not.
    const match = findOverlappingRequest({ departAt: "2026-09-16T06:00:00Z", returnAt: null }, existing);
    expect(match?.id).toBe("b");
  });

  it("does not match one-way instants a few minutes apart", () => {
    const match = findOverlappingRequest({ departAt: "2026-09-16T06:30:00Z", returnAt: null }, existing);
    expect(match).toBeNull();
  });

  it("returns null for a candidate with no times at all", () => {
    const match = findOverlappingRequest({ departAt: null, returnAt: null }, existing);
    expect(match).toBeNull();
  });
});
