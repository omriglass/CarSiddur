/** AN1: the stats RPC returns untyped jsonb; these read it defensively. */
export function asNumber(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

/** `{value: count}` → `[value, count][]`, largest first, then by value. */
export function asCounts(value: unknown): [string, number][] {
  if (!value || typeof value !== "object" || Array.isArray(value)) return [];
  return Object.entries(value as Record<string, unknown>)
    .map(([key, count]) => [key, asNumber(count)] as [string, number])
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
}
