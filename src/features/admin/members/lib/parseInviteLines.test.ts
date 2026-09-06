import { describe, expect, it } from "vitest";

import { parseInviteLines } from "./parseInviteLines";

describe("parseInviteLines", () => {
  it("parses comma-separated 'name, email' lines", () => {
    const rows = parseInviteLines("דנה כהן, dana@nevo.local\nרון לוי, ron@nevo.local");
    expect(rows).toEqual([
      { name: "דנה כהן", email: "dana@nevo.local", status: "new" },
      { name: "רון לוי", email: "ron@nevo.local", status: "new" },
    ]);
  });

  it("accepts tab and semicolon separators", () => {
    const rows = parseInviteLines("דנה כהן\tdana@nevo.local\nרון לוי;ron@nevo.local");
    expect(rows.map((r) => r.email)).toEqual(["dana@nevo.local", "ron@nevo.local"]);
  });

  it("skips a header row", () => {
    const rows = parseInviteLines("שם, אימייל\nדנה כהן, dana@nevo.local");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ email: "dana@nevo.local" });
  });

  it("does not mistake a real name+email first row for a header", () => {
    const rows = parseInviteLines("דנה כהן, dana@nevo.local\nרון לוי, ron@nevo.local");
    expect(rows).toHaveLength(2);
  });

  it("flags an invalid email", () => {
    const rows = parseInviteLines("דנה כהן, not-an-email");
    expect(rows).toEqual([{ name: "דנה כהן", email: "not-an-email", status: "invalid_email" }]);
  });

  it("flags duplicates within the pasted batch, case-insensitively, keeping the first row's status", () => {
    const rows = parseInviteLines("דנה, dana@nevo.local\nדנה שוב, DANA@nevo.local", new Set(["dana@nevo.local"]));
    expect(rows[0]).toMatchObject({ status: "existing" });
    expect(rows[1]).toMatchObject({ status: "duplicate" });
  });

  it("classifies existing emails (case-insensitive) as 'existing'", () => {
    const rows = parseInviteLines("דנה, dana@nevo.local", new Set(["Dana@Nevo.local"]));
    expect(rows[0]!.status).toBe("existing");
  });

  it("trims whitespace around fields", () => {
    const rows = parseInviteLines("  דנה כהן  ,   dana@nevo.local  ");
    expect(rows[0]).toEqual({ name: "דנה כהן", email: "dana@nevo.local", status: "new" });
  });

  it("ignores blank lines", () => {
    const rows = parseInviteLines("דנה, dana@nevo.local\n\n\nרון, ron@nevo.local");
    expect(rows).toHaveLength(2);
  });

  it("returns an empty array for empty input", () => {
    expect(parseInviteLines("")).toEqual([]);
  });
});
