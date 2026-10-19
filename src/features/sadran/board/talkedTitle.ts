import { he, tv } from "@/i18n/he";

/** REQ §13.138 (a): "דיברת עם X, Y על השינוי?" — the people the change needs, or a neutral title when none is known. */
export function talkedTitle(names: readonly string[]): string {
  const known = [...new Set(names.map((name) => name.trim()).filter((name) => name !== ""))];
  return known.length ? tv("boardDrafts.talkedTitle", { names: known.join(", ") }) : he.boardDrafts.talkedTitleNoName;
}
