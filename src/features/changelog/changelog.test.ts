import { describe, expect, it } from "vitest";

import { CHANGELOG, type ChangelogEntry } from "@/i18n/he.changelog";
import { he } from "@/i18n/he";

import { inboxMessage, sectionsFor } from "./changelog";

const entry: ChangelogEntry = { id: "x", date: "2026-10-19", title: "T", users: ["u"], sadran: ["s"], admin: ["a"] };
const member = { isSadran: false, isAdmin: false };

describe("changelog sections", () => {
  it("gives each reader only their sections", () => {
    expect(sectionsFor(entry, member)).toEqual(["users"]);
    expect(sectionsFor(entry, { isSadran: true, isAdmin: false })).toEqual(["users", "sadran"]);
    expect(sectionsFor(entry, { isSadran: false, isAdmin: true })).toEqual(["users", "sadran", "admin"]);
  });

  it("a member's message has no headings; a Sadran's has one per section", () => {
    expect(inboxMessage(entry, member)?.body).toBe("• u");
    expect(inboxMessage(entry, { isSadran: true, isAdmin: false })?.body).toBe(`${he.changelog.users}:\n• u\n\n${he.changelog.sadran}:\n• s`);
  });

  it("sends nothing when the version has nothing for the reader", () => {
    expect(inboxMessage({ ...entry, users: [], sadran: [] }, member)).toBeNull();
  });
});

describe("CHANGELOG", () => {
  it("is newest first, with unique, well-formed ids", () => {
    const dates = CHANGELOG.map((e) => e.date);
    expect([...dates].sort().reverse()).toEqual(dates);
    expect(new Set(CHANGELOG.map((e) => e.id)).size).toBe(CHANGELOG.length);
    for (const e of CHANGELOG) {
      expect(e.id).toMatch(/^[a-z0-9][a-z0-9._-]{0,63}$/);
      expect(e.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(e.users.length + e.sadran.length + e.admin.length).toBeGreaterThan(0);
    }
  });
});
