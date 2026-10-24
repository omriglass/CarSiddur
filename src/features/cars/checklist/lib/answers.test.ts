import { describe, expect, it } from "vitest";

import type { ChecklistItem } from "../api";
import { buildChecklistAnswers, canSubmitChecklist, EMPTY_DRAFT, isAnswered, normalizeFailures, parseChecklistNumber } from "./answers";

function item(id: string, kind: ChecklistItem["kind"], overrides: Partial<ChecklistItem> = {}): ChecklistItem {
  return {
    id, kind, department_id: "d", position: 0, label: id, required: true, active: true, remind_days_before: null,
    created_at: "", updated_at: "", ...overrides,
  };
}

describe("parseChecklistNumber", () => {
  it("accepts digits and decimals, rejects the rest", () => {
    expect(parseChecklistNumber("12")).toBe(12);
    expect(parseChecklistNumber(" 1,234.5 ")).toBe(1234.5);
    expect(parseChecklistNumber("")).toBeNull();
    expect(parseChecklistNumber("-3")).toBeNull();
    expect(parseChecklistNumber("abc")).toBeNull();
  });
});

describe("checklist answers", () => {
  const items = [item("a", "yes_no"), item("b", "number"), item("c", "date"), item("d", "yes_no", { required: false }), item("e", "yes_no", { active: false })];

  it("needs every required active item", () => {
    expect(canSubmitChecklist(items, {})).toBe(false);
    const drafts = { a: { ...EMPTY_DRAFT, bool: false }, b: { ...EMPTY_DRAFT, text: "5" }, c: { ...EMPTY_DRAFT, text: "2026-12-01" } };
    expect(canSubmitChecklist(items, drafts)).toBe(true);
    expect(canSubmitChecklist([], {})).toBe(false);
  });

  it("builds the payload from answered active items only", () => {
    const drafts = {
      a: { ...EMPTY_DRAFT, bool: true, note: " ok " }, b: { ...EMPTY_DRAFT, text: "7.5" }, c: { ...EMPTY_DRAFT, text: "2026-12-01" },
      d: EMPTY_DRAFT, e: { ...EMPTY_DRAFT, bool: true },
    };
    expect(buildChecklistAnswers(items, drafts)).toEqual([
      { item_id: "a", value: true, note: "ok" }, { item_id: "b", value: 7.5 }, { item_id: "c", value: "2026-12-01" },
    ]);
    expect(isAnswered(item("x", "yes_no"), EMPTY_DRAFT)).toBe(false);
  });

  it("normalizes failures", () => {
    expect(normalizeFailures(null)).toEqual([]);
    expect(normalizeFailures([{ label: "x", reason: "no" }, 3])).toHaveLength(1);
  });
});
