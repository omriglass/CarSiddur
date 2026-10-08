// UX_FLOWS §3.4a: the member's last four distinct destinations from their own requests,
// newest first, shown as chips above the destination search.
import type { DestinationValue } from "@/components/DestinationCombobox";

import { isSamePlace } from "./schema";

export interface RecentDestinationSource {
  departAt: string | null;
  returnAt: string | null;
  status: string;
  destination: string;
  destinationId?: string | null;
  destinationText?: string | null;
}

export const RECENT_DESTINATION_COUNT = 4;

export function recentDestinations(rows: readonly RecentDestinationSource[], limit = RECENT_DESTINATION_COUNT): DestinationValue[] {
  const stamp = (row: RecentDestinationSource) => Date.parse(row.departAt ?? row.returnAt ?? "") || 0;
  const sorted = [...rows].filter((row) => row.status !== "withdrawn").sort((a, b) => stamp(b) - stamp(a));
  const result: DestinationValue[] = [];
  for (const row of sorted) {
    const value: DestinationValue | null = row.destinationId
      ? { presetId: row.destinationId, name: row.destination }
      : row.destinationText?.trim()
        ? { freeText: row.destinationText.trim() }
        : null;
    if (!value || result.some((existing) => isSamePlace(existing, value))) continue;
    result.push(value);
    if (result.length >= limit) break;
  }
  return result;
}
