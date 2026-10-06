import { he, tv } from "@/i18n/he";
import { formatDayDate } from "@/lib/dayLabels";
import { formatTime } from "@/lib/time";

import type { MyRequestRow } from "./api";

/**
 * R2B24: a submit refused/parked with `reason: "DUPLICATE_OVERLAP"` carries `overlaps` (ids only).
 * Names each overlapping own request/ride from the member's loaded requests ("בית חולים · ד׳ 16.9 08:00–10:00");
 * ids we cannot resolve are dropped. Never shows the raw code.
 */
export function overlapNames(
  overlaps: readonly { request_id: string | null; ride_id: string | null }[] | undefined,
  mine: readonly Pick<MyRequestRow, "id" | "destination" | "departAt" | "returnAt" | "ride">[],
): string[] {
  const names: string[] = [];
  for (const o of overlaps ?? []) {
    const row = mine.find((r) => (o.request_id && r.id === o.request_id) || (o.ride_id && r.ride?.id === o.ride_id));
    if (!row) continue;
    const start = row.ride?.startsAt ?? row.departAt ?? row.returnAt;
    const end = row.ride?.endsAt ?? row.returnAt ?? row.departAt;
    const when = start && end ? `${formatDayDate(start)} ⁦${formatTime(new Date(start))}–${formatTime(new Date(end))}⁩` : "";
    names.push([row.destination, when].filter(Boolean).join(" · "));
  }
  return names;
}

/** The toast text for a request parked because it overlaps the member's own request/ride. */
export function overlapRefusalMessage(names: readonly string[]): string {
  return names.length > 0 ? tv("request.overlapRefusedNamed", { names: names.join("; ") }) : he.request.overlapRefused;
}
