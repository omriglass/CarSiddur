import type { ChecklistAnswerInput, ChecklistFailure, ChecklistItem } from "../api";

/** What the form holds per item: a yes/no choice, or the raw text of a number / date input. */
export interface ChecklistDraftValue {
  bool: boolean | null;
  text: string;
  note: string;
}

export const EMPTY_DRAFT: ChecklistDraftValue = { bool: null, text: "", note: "" };

/** Parses "1234" / "1,234.5" (digits only, optional decimals); null when empty or not a non-negative number. */
export function parseChecklistNumber(text: string): number | null {
  const cleaned = text.trim().replace(/,/g, "");
  if (!/^\d+(\.\d+)?$/.test(cleaned)) return null;
  const value = Number(cleaned);
  return Number.isFinite(value) ? value : null;
}

/** True when the draft holds an answer for the item's kind. */
export function isAnswered(item: Pick<ChecklistItem, "kind">, draft: ChecklistDraftValue): boolean {
  if (item.kind === "yes_no") return draft.bool !== null;
  if (item.kind === "number") return parseChecklistNumber(draft.text) !== null;
  return /^\d{4}-\d{2}-\d{2}$/.test(draft.text);
}

/** Every required (active) item is answered — the same condition `submit_car_checklist` enforces. */
export function canSubmitChecklist(items: readonly ChecklistItem[], drafts: Record<string, ChecklistDraftValue>): boolean {
  const active = items.filter((item) => item.active);
  return active.length > 0 && active.every((item) => !item.required || isAnswered(item, drafts[item.id] ?? EMPTY_DRAFT));
}

/** The RPC payload: answered items only (blank optional items are skipped). */
export function buildChecklistAnswers(items: readonly ChecklistItem[], drafts: Record<string, ChecklistDraftValue>): ChecklistAnswerInput[] {
  const answers: ChecklistAnswerInput[] = [];
  for (const item of items) {
    if (!item.active) continue;
    const draft = drafts[item.id] ?? EMPTY_DRAFT;
    if (!isAnswered(item, draft)) continue;
    const value = item.kind === "yes_no" ? draft.bool : item.kind === "number" ? parseChecklistNumber(draft.text) : draft.text;
    answers.push({ item_id: item.id, value, ...(draft.note.trim() ? { note: draft.note.trim() } : {}) });
  }
  return answers;
}

/** "Failed" list as shown on the card; unknown shapes (old rows) are dropped. */
export function normalizeFailures(raw: unknown): ChecklistFailure[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter((f): f is ChecklistFailure => !!f && typeof f === "object" && typeof (f as ChecklistFailure).label === "string");
}
