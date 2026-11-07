import type { SendAllPreviewItem, SendAllSkips } from "../api";

/** TODO SA2: the preview's notices per person — each person's list is what reaches their phone. */
export interface RecipientPreview {
  recipientId: string;
  name: string;
  items: SendAllPreviewItem[];
}

export function groupByRecipient(items: readonly SendAllPreviewItem[]): RecipientPreview[] {
  const byId = new Map<string, RecipientPreview>();
  for (const item of items) {
    const group = byId.get(item.recipient_id) ?? { recipientId: item.recipient_id, name: item.recipient_name, items: [] };
    group.items.push(item);
    byId.set(item.recipient_id, group);
  }
  return [...byId.values()];
}

/** A notice is sent unless one of the held notices / proposals behind it is unticked (a proposal reaches all its parties). */
export function isItemOn(item: SendAllPreviewItem, skipped: ReadonlySet<string>): boolean {
  return item.keys.every((key) => !skipped.has(key));
}

export function toggleKeys(skipped: ReadonlySet<string>, keys: readonly string[], on: boolean): Set<string> {
  const next = new Set(skipped);
  for (const key of keys) {
    if (on) next.delete(key); else next.add(key);
  }
  return next;
}

const PROPOSAL_PREFIX = "proposal:";

export function skipsOf(skipped: ReadonlySet<string>): SendAllSkips {
  const keys: string[] = [];
  const proposals: string[] = [];
  for (const key of [...skipped].sort()) {
    if (key.startsWith(PROPOSAL_PREFIX)) proposals.push(key.slice(PROPOSAL_PREFIX.length)); else keys.push(key);
  }
  return { keys, proposals };
}
