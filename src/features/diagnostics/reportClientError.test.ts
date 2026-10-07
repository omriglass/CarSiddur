import { beforeEach, describe, expect, it, vi } from "vitest";

const insertClientError = vi.fn<(row: unknown) => Promise<boolean>>();
const currentProfileId = vi.fn<() => Promise<string | null>>();

vi.mock("./api", () => ({
  insertClientError: (row: unknown) => insertClientError(row),
  currentProfileId: () => currentProfileId(),
}));

async function load() {
  vi.resetModules();
  return import("./reportClientError");
}

beforeEach(() => {
  insertClientError.mockReset().mockResolvedValue(true);
  currentProfileId.mockReset().mockResolvedValue("u1");
  vi.stubGlobal("__APP_VERSION__", "test-version");
  vi.stubGlobal("window", { location: { pathname: "/p/secret", search: "" } });
  vi.stubGlobal("navigator", { userAgent: "UA" });
});

describe("reportClientError", () => {
  it("inserts a sanitised row for the signed-in user", async () => {
    const { reportClientError } = await load();
    reportClientError({ message: "boom", stack: "at x" });
    await vi.waitFor(() => expect(insertClientError).toHaveBeenCalledTimes(1));
    const row = insertClientError.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(row).toMatchObject({ message: "boom", profile_id: "u1", app_version: "test-version", url: "/p/…", user_agent: "UA" });
  });

  it("sends the same message once", async () => {
    const { reportClientError } = await load();
    reportClientError({ message: "dup" });
    reportClientError({ message: "dup" });
    await vi.waitFor(() => expect(insertClientError).toHaveBeenCalledTimes(1));
  });

  it("does nothing without a session", async () => {
    currentProfileId.mockResolvedValue(null);
    const { reportClientError } = await load();
    reportClientError({ message: "anon" });
    await vi.waitFor(() => expect(currentProfileId).toHaveBeenCalled());
    await Promise.resolve();
    expect(insertClientError).not.toHaveBeenCalled();
  });

  it("never throws, even when the session lookup or insert fails", async () => {
    currentProfileId.mockRejectedValue(new Error("session boom"));
    const { reportClientError } = await load();
    expect(() => reportClientError({ message: "a" })).not.toThrow();
    currentProfileId.mockResolvedValue("u1");
    insertClientError.mockRejectedValue(new Error("insert boom"));
    expect(() => reportClientError({ message: "b" })).not.toThrow();
    expect(() => reportClientError(undefined as never)).not.toThrow();
    await new Promise((r) => setTimeout(r, 0));
  });
});

describe("errorToReport", () => {
  it("handles Error, string and plain objects", async () => {
    const { errorToReport } = await load();
    expect(errorToReport(new Error("e"), "ctx")).toMatchObject({ message: "e", context: "ctx" });
    expect(errorToReport("text")).toEqual({ message: "text", context: undefined });
    expect(errorToReport({ a: 1 }).message).toBe('{"a":1}');
  });
});
