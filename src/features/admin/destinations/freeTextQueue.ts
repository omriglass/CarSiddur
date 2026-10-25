/**
 * The "טקסט חופשי לסיווג" queue (REQ §13.152, UX_FLOWS §5.6): distinct typed place texts of the department's requests,
 * minus those already on the list (an approved place's name or alias) and those the admin chose to ignore.
 */

/** TS twin of SQL `normalize_place_text()`: whitespace runs collapsed, trimmed, lower case. */
export function normalizePlaceText(text: string | null | undefined): string {
  return (text ?? "").replace(/\s+/g, " ").trim().toLowerCase();
}

export interface FreeTextGroup {
  text: string;
  key: string;
  count: number;
  lastUsedAt: string;
}

export interface IgnoredFreeText {
  id: string;
  text: string;
  key: string;
  count: number;
}

/** One group per normalized text, newest use first; the displayed text is the first spelling seen. */
export function groupFreeTexts(rows: readonly { text: string | null; createdAt: string }[]): FreeTextGroup[] {
  const groups = new Map<string, FreeTextGroup>();
  for (const row of rows) {
    const key = normalizePlaceText(row.text);
    if (!key) continue;
    const existing = groups.get(key);
    if (existing) {
      existing.count += 1;
      if (row.createdAt > existing.lastUsedAt) existing.lastUsedAt = row.createdAt;
    } else {
      groups.set(key, { text: (row.text ?? "").trim(), key, count: 1, lastUsedAt: row.createdAt });
    }
  }
  return [...groups.values()].sort((a, b) => b.lastUsedAt.localeCompare(a.lastUsedAt) || a.key.localeCompare(b.key));
}

/** Splits the groups into what still needs a decision and what was ignored (ignored texts listed even when unused now). */
export function splitFreeTextQueue(
  groups: readonly FreeTextGroup[],
  destinations: readonly { name: string; aliases: readonly string[]; is_approved: boolean }[],
  ignored: readonly { id: string; text: string; text_key: string | null }[],
): { pending: FreeTextGroup[]; ignored: IgnoredFreeText[] } {
  const known = new Set(destinations.filter((d) => d.is_approved).flatMap((d) => [d.name, ...d.aliases].map(normalizePlaceText)));
  const ignoredByKey = new Map(ignored.map((row) => [row.text_key ?? normalizePlaceText(row.text), row]));
  const countByKey = new Map(groups.map((group) => [group.key, group.count]));
  return {
    pending: groups.filter((group) => !known.has(group.key) && !ignoredByKey.has(group.key)),
    ignored: [...ignoredByKey.entries()]
      .map(([key, row]) => ({ id: row.id, text: row.text, key, count: countByKey.get(key) ?? 0 }))
      .sort((a, b) => a.text.localeCompare(b.text, "he")),
  };
}

/** The aliases to save when a place is created from a queue text: the typed text is kept when the name differs. */
export function aliasesWithQueueText(name: string, aliases: readonly string[], queueText: string | undefined): string[] {
  if (!queueText) return [...aliases];
  const key = normalizePlaceText(queueText);
  if (!key || normalizePlaceText(name) === key || aliases.some((alias) => normalizePlaceText(alias) === key)) return [...aliases];
  return [...aliases, queueText.trim()];
}
