// REQ §13.112 (c): "4 שעות בין 07:00 ל־12:00" under a window request's own times — `/my` row, the board's unmet
// card and request details. Renders nothing for an ordinary request. Times are LTR isolates.
import { cn } from "@/lib/utils";

import { windowSummary, type StoredWindow } from "../timeWindow";
import { LtrText } from "./requestForm/sentence/LtrText";

export function WindowSummaryLine({ row, className, testId = "request-window" }: { row: StoredWindow; className?: string; testId?: string }) {
  const text = windowSummary(row);
  if (!text) return null;
  return (
    <p className={cn("text-xs font-medium", className)} data-testid={testId}>
      <LtrText text={text} />
    </p>
  );
}
