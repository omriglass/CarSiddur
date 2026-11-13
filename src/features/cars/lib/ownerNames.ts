import { tv } from "@/i18n/he";

/** "X", "X וY", "X, Y וZ" — the owners of a private car in one phrase (PC1, REQ item 227 e). */
export function joinNames(names: readonly string[]): string {
  const known = [...new Set(names.map((name) => name.trim()).filter((name) => name !== ""))];
  if (known.length <= 1) return known[0] ?? "";
  return tv("carPage.namesLast", { rest: known.slice(0, -1).join(", "), last: known[known.length - 1] ?? "" });
}
