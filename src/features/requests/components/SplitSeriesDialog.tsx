import { useState } from "react";
import { toast } from "sonner";

import { FormDialog } from "@/components/FormDialog";
import { Button } from "@/components/ui/button";
import { he, tv } from "@/i18n/he";
import { formatDayDate } from "@/lib/dayLabels";

import { useSplitSeriesMutation } from "../hooks";
import { seriesDays, splitCuts, splitParts, type SplitMode } from "../split";

/** What to split: any day's request of the series, its first day and length; `version` when known (stale check). */
export interface SplitTarget {
  requestId: string;
  firstDay: string;
  count: number;
  version?: number | null;
}

const dayLabel = (day: string) => formatDayDate(`${day}T12:00:00Z`);
const partLabel = (part: readonly string[]) =>
  part.length === 1 ? dayLabel(part[0] ?? "") : `${dayLabel(part[0] ?? "")}–${dayLabel(part[part.length - 1] ?? "")}`;

/**
 * SP1 (REQ item 228): "פיצול" — in two at a chosen day, or one ride per day. Every part keeps the car and each day's
 * own times; the parts are then moved, edited or cancelled on their own.
 */
export function SplitSeriesDialog({ target, onOpenChange }: { target: SplitTarget | null; onOpenChange: (open: boolean) => void }) {
  const [mode, setMode] = useState<SplitMode>("two");
  const [at, setAt] = useState(1);
  const mutation = useSplitSeriesMutation();
  const days = target ? seriesDays(target.firstDay, target.count) : [];
  const cuts = target ? splitCuts(mode, target.count, at) : [];
  const parts = splitParts(days, cuts);

  function close(open: boolean) {
    if (!open) { setMode("two"); setAt(1); }
    onOpenChange(open);
  }

  return (
    <FormDialog
      open={!!target}
      onOpenChange={close}
      title={he.request.splitSeriesTitle}
      description={he.request.splitSeriesHelp}
      submitLabel={he.request.splitSubmit}
      loading={mutation.isPending}
      submitDisabled={cuts.length === 0}
      onSubmit={() => {
        if (!target || cuts.length === 0) return;
        mutation.mutate(
          { requestId: target.requestId, cutAfter: cuts, expectedVersion: target.version ?? null },
          { onSuccess: () => { toast.success(he.request.splitDone); close(false); } },
        );
      }}
    >
      <div className="space-y-4" data-testid="split-series-form">
        <div role="radiogroup" aria-label={he.request.splitSeriesTitle} className="flex gap-2">
          {(["two", "daily"] as const).map((value) => (
            <Button key={value} type="button" role="radio" aria-checked={mode === value} variant={mode === value ? "default" : "outline"}
              className="min-h-11 flex-1" onClick={() => setMode(value)} data-testid={`split-mode-${value}`}>
              {value === "two" ? he.request.splitModeTwo : he.request.splitModeDaily}
            </Button>
          ))}
        </div>
        {mode === "two" ? (
          <div className="space-y-2">
            <p className="text-sm font-medium">{he.request.splitAtLabel}</p>
            <div role="radiogroup" aria-label={he.request.splitAtLabel} className="flex flex-wrap gap-2">
              {days.slice(0, -1).map((day, i) => (
                <Button key={day} type="button" role="radio" aria-checked={at === i + 1} variant={at === i + 1 ? "default" : "outline"}
                  className="min-h-11" onClick={() => setAt(i + 1)} data-testid="split-at">
                  {/* R20U5 (QA run 20): "2 + 1" read backwards in RTL - each option names the day the second part starts. */}
                  {tv("request.splitAtDay", { day: dayLabel(days[i + 1] ?? day) })}
                </Button>
              ))}
            </div>
          </div>
        ) : null}
        <div className="space-y-1 text-sm">
          <p className="font-medium">{he.request.splitPartsPreview}</p>
          <ul className="list-inside list-disc text-muted-foreground" data-testid="split-parts">
            {parts.map((part) => <li key={part[0]}>{partLabel(part)}</li>)}
          </ul>
        </div>
      </div>
    </FormDialog>
  );
}
