import { describe, expect, it } from "vitest";

import { buildShortenArgs, type SeriesDayOption } from "./shorten";

const days: SeriesDayOption[] = [
  { day: "2026-10-12", departTime: "08:00", returnTime: null },
  { day: "2026-10-13", departTime: null, returnTime: null },
  { day: "2026-10-14", departTime: null, returnTime: "18:00" },
];

describe("buildShortenArgs", () => {
  it("builds Jerusalem instants for a sub-span", () => {
    const r = buildShortenArgs({ days, firstDay: "2026-10-13", departTime: "09:15", lastDay: "2026-10-14", returnTime: "17:00" });
    expect(r).toEqual({ departAt: "2026-10-13T06:15:00.000Z", returnAt: "2026-10-14T14:00:00.000Z" });
  });
  it("needs two days", () => {
    // One kept day is allowed (REQ §13.103 c); a return before the departure on that day is not.
    expect("departAt" in buildShortenArgs({ days, firstDay: "2026-10-13", departTime: "09:00", lastDay: "2026-10-13", returnTime: "17:00" })).toBe(true);
    expect(buildShortenArgs({ days, firstDay: "2026-10-13", departTime: "17:00", lastDay: "2026-10-13", returnTime: "09:00" })).toEqual({ error: "invalidRange" });
  });
  it("rejects an unchanged span", () => {
    expect(buildShortenArgs({ days, firstDay: "2026-10-12", departTime: "08:00", lastDay: "2026-10-14", returnTime: "18:00" })).toEqual({ error: "unchanged" });
  });
});
