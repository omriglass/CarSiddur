import { useState } from "react";

import { ConfirmDialog } from "@/components/ConfirmDialog";
import { Button } from "@/components/ui/button";
import { he, tv } from "@/i18n/he";
import { formatDayDate } from "@/lib/dayLabels";

interface AutoFillDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Week days as `yyyy-MM-dd`. */
  days: string[];
  /** The board's currently selected day: the default choice. */
  defaultDay: string;
  /** Open (unplaced) requests anchored on a day, or the whole week for `null`. */
  openCount: (day: string | null) => number;
  loading: boolean;
  onConfirm: (day: string | null) => void;
}

/** "Complete automatically" scope picker + confirmation (REQ §13.109 b): one day, or the whole week explicitly. */
export function AutoFillDialog({ open, onOpenChange, days, defaultDay, openCount, loading, onConfirm }: AutoFillDialogProps) {
  const [picked, setPicked] = useState<string | null | undefined>(undefined);
  const choice = picked === undefined ? defaultDay : picked;
  const count = openCount(choice);
  const dayLabel = (d: string) => formatDayDate(new Date(`${d}T12:00:00Z`));
  return (
    <ConfirmDialog
      open={open}
      onOpenChange={(next) => { if (!next) setPicked(undefined); onOpenChange(next); }}
      title={he.sadranBoard.autoFill.title}
      description={he.sadranBoard.autoFill.description}
      confirmLabel={he.sadranBoard.autoFill.confirmAction}
      confirmDisabled={count === 0}
      loading={loading}
      onConfirm={() => onConfirm(choice)}
    >
      <div className="flex flex-wrap gap-2" role="radiogroup" aria-label={he.sadranBoard.autoFill.title}>
        {days.map((d) => (
          <Button key={d} type="button" size="sm" role="radio" aria-checked={choice === d}
            variant={choice === d ? "default" : "outline"} className="min-h-11" data-testid={`autofill-day-${d}`}
            onClick={() => setPicked(d)}>
            <span dir="ltr">{dayLabel(d)}</span>
            {openCount(d) > 0 ? <span className="ms-1 text-xs">({openCount(d)})</span> : null}
          </Button>
        ))}
        <Button type="button" size="sm" role="radio" aria-checked={choice === null}
          variant={choice === null ? "default" : "outline"} className="min-h-11" data-testid="autofill-day-week"
          onClick={() => setPicked(null)}>
          {he.sadranBoard.autoFill.wholeWeek}
        </Button>
      </div>
      <p className="text-sm" data-testid="autofill-confirm-text">
        {count === 0
          ? he.sadranBoard.autoFill.confirmNone
          : choice === null
            ? tv("sadranBoard.autoFill.confirmWeek", { count: String(count) })
            : tv("sadranBoard.autoFill.confirmDay", { count: String(count), day: dayLabel(choice) })}
      </p>
    </ConfirmDialog>
  );
}
