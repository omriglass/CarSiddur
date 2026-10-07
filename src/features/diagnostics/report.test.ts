import { describe, expect, it } from "vitest";

import {
  buildClientErrorRow,
  createReportGate,
  DEDUPE_WINDOW_MS,
  isIgnoredMessage,
  isUnexpectedErrorCode,
  REPORT_CAP,
  sanitizeUrl,
} from "./report";

describe("sanitizeUrl", () => {
  it("keeps a plain path and query", () => {
    expect(sanitizeUrl("/siddur/d1/2027-01-10", "?ride=r1")).toBe("/siddur/d1/2027-01-10?ride=r1");
    expect(sanitizeUrl("/my", "")).toBe("/my");
  });

  it("masks the proposal token path", () => {
    expect(sanitizeUrl("/p/abc123secret", "")).toBe("/p/…");
    expect(sanitizeUrl("/p/abc123secret/", "")).toBe("/p/…/");
  });

  it("drops credential-looking query parameters", () => {
    expect(sanitizeUrl("/login", "?access_token=x&next=%2Fmy&code=9")).toBe("/login?next=%2Fmy");
    expect(sanitizeUrl("/login", "?token=x")).toBe("/login");
  });

  it("caps the length", () => {
    expect(sanitizeUrl(`/${"a".repeat(2000)}`, "").length).toBe(500);
  });
});

describe("createReportGate", () => {
  it("dedupes the same message inside the window and allows it again after", () => {
    let now = 1_000;
    const gate = createReportGate({ now: () => now });
    expect(gate.accept("boom")).toBe(true);
    now += DEDUPE_WINDOW_MS - 1;
    expect(gate.accept("boom")).toBe(false);
    expect(gate.accept("other")).toBe(true);
    now += 2;
    expect(gate.accept("boom")).toBe(true);
  });

  it("stops after the per-session cap, deduped repeats not counting", () => {
    const gate = createReportGate({ now: () => 0 });
    expect(gate.accept("same")).toBe(true);
    expect(gate.accept("same")).toBe(false);
    for (let i = 1; i < REPORT_CAP; i += 1) expect(gate.accept(`m${i}`)).toBe(true);
    expect(gate.accept("one-too-many")).toBe(false);
  });
});

describe("expected vs unexpected", () => {
  it("reports only unknown and network", () => {
    expect(isUnexpectedErrorCode("unknown")).toBe(true);
    expect(isUnexpectedErrorCode("network")).toBe(true);
    for (const code of ["stale_version", "stale_input", "not_authorized", "constraint_violation", "duplicate_value", "push_unsupported"]) {
      expect(isUnexpectedErrorCode(code)).toBe(false);
    }
  });

  it("ignores browser noise", () => {
    expect(isIgnoredMessage("ResizeObserver loop completed with undelivered notifications.")).toBe(true);
    expect(isIgnoredMessage("Script error.")).toBe(true);
    expect(isIgnoredMessage("Cannot read properties of undefined")).toBe(false);
  });
});

describe("buildClientErrorRow", () => {
  const env = { pathname: "/p/tok", search: "", appVersion: "v1", userAgent: "UA", profileId: "u1" };

  it("fills the environment and prefixes the context to the stack", () => {
    const row = buildClientErrorRow({ message: "m", stack: "at x", context: "ErrorScreen" }, env);
    expect(row).toEqual({
      message: "m",
      stack: "[ErrorScreen]\nat x",
      url: "/p/…",
      app_version: "v1",
      user_agent: "UA",
      profile_id: "u1",
    });
  });

  it("uses a null stack when there is neither stack nor context and truncates long text", () => {
    const row = buildClientErrorRow({ message: "x".repeat(5000) }, env);
    expect(row.stack).toBeNull();
    expect(row.message.length).toBe(1000);
  });
});
