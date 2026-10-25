import { describe, expect, it } from "vitest";

import { aliasesWithQueueText, groupFreeTexts, normalizePlaceText, splitFreeTextQueue } from "./freeTextQueue";

describe("freeTextQueue", () => {
  it("normalizes like SQL normalize_place_text", () => {
    expect(normalizePlaceText("  Rishon   LeZion ")).toBe("rishon lezion");
  });

  it("groups spellings that differ only by spaces / case, newest first", () => {
    const groups = groupFreeTexts([
      { text: "Rishon", createdAt: "2026-10-01" },
      { text: " rishon ", createdAt: "2026-10-05" },
      { text: "Klikson", createdAt: "2026-10-03" },
      { text: "  ", createdAt: "2026-10-04" },
    ]);
    expect(groups.map((g) => [g.text, g.count])).toEqual([["Rishon", 2], ["Klikson", 1]]);
  });

  it("drops texts already on the list (approved name or alias) and ignored ones", () => {
    const groups = groupFreeTexts([
      { text: "Rishon", createdAt: "2026-10-01" },
      { text: "Rishon LeZion", createdAt: "2026-10-02" },
      { text: "Klikson", createdAt: "2026-10-03" },
      { text: "Offlist", createdAt: "2026-10-04" },
      { text: "Haifa", createdAt: "2026-10-05" },
    ]);
    const { pending, ignored } = splitFreeTextQueue(
      groups,
      [
        { name: "Rishon LeZion", aliases: ["rishon"], is_approved: true },
        { name: "Offlist", aliases: [], is_approved: false },
      ],
      [{ id: "i1", text: "Klikson", text_key: "klikson" }, { id: "i2", text: "Gone", text_key: "gone" }],
    );
    expect(pending.map((g) => g.text)).toEqual(["Haifa", "Offlist"]);
    expect(ignored.map((g) => [g.text, g.count])).toEqual([["Gone", 0], ["Klikson", 1]]);
  });

  it("keeps the typed text as an alias when the new place got another name", () => {
    expect(aliasesWithQueueText("Rishon LeZion", [], "Rishon")).toEqual(["Rishon"]);
    expect(aliasesWithQueueText("Rishon", [], " rishon ")).toEqual([]);
    expect(aliasesWithQueueText("Rishon LeZion", ["RISHON"], "rishon")).toEqual(["RISHON"]);
    expect(aliasesWithQueueText("Haifa", ["x"], undefined)).toEqual(["x"]);
  });
});
