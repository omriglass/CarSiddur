import { tv } from "@/i18n/he";
import { formatDayDate } from "@/lib/dayLabels";
import { formatTime } from "@/lib/time";

import type { ChildOverlapRow } from "./api";

/** R2M4: "{{child}} כבר בבקשה של {{name}} ({{time}}) — להגיש בכל זאת?" for one overlap row. */
export function childOverlapMessage(row: Pick<ChildOverlapRow, "childName" | "requesterName" | "departAt" | "returnAt">): string {
  const time = `${formatDayDate(row.departAt)} ⁦${formatTime(new Date(row.departAt))}–${formatTime(new Date(row.returnAt))}⁩`;
  return tv("request.childOverlap", { child: row.childName, name: row.requesterName, time });
}
