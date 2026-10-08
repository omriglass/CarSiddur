// UX_FLOWS §3.4a "Time sheet": the shared core of every time sheet of the sentence form — the
// optional anchor toggle, the 15-minute time field and the derived estimate line. Used by
// `TimeAnchorSheet` (main out/return times) and `PlanBLine` (plan-B drop and pickup times).
import type { ReactNode } from "react";

import { TimeField15 } from "@/components/TimeField15";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { he, tv } from "@/i18n/he";
import type { TimeAnchor } from "@/lib/enums";

import type { AnchorEstimate } from "../../../timeAnchors";
import { FieldError } from "../FieldError";
import { LtrText } from "./LtrText";

interface AnchorTimePickerProps {
  /** The toggle's options in display order; `null` = no toggle (a single meaning). */
  anchors: readonly TimeAnchor[] | null;
  anchor: TimeAnchor;
  anchorLabel: (anchor: TimeAnchor) => string;
  onAnchorChange: (anchor: TimeAnchor) => void;
  value: string;
  onChange: (value: string) => void;
  min?: string;
  max?: string;
  ariaLabel: string;
  /** react-hook-form field name for `useScrollToFirstError`. */
  dataField: string;
  error?: string;
  estimate: AnchorEstimate | null;
  estimateTestId: string;
  /** Rendered between the error and the estimate line. */
  beforeEstimate?: ReactNode;
}

export function AnchorTimePicker({
  anchors, anchor, anchorLabel, onAnchorChange, value, onChange, min, max, ariaLabel, dataField, error, estimate, estimateTestId, beforeEstimate,
}: AnchorTimePickerProps) {
  return (
    <>
      {anchors ? (
        <ToggleGroup
          type="single"
          value={anchor}
          onValueChange={(next) => {
            if (next) onAnchorChange(next as TimeAnchor);
          }}
          className="grid grid-cols-2 gap-0 rounded-full bg-muted p-0.5"
          aria-label={he.requestSentence.anchorToggle}
        >
          {anchors.map((option) => (
            <ToggleGroupItem key={option} value={option} className="h-8 rounded-full text-sm data-[state=on]:bg-background data-[state=on]:font-medium data-[state=on]:text-primary data-[state=on]:shadow-sm">
              {anchorLabel(option)}
            </ToggleGroupItem>
          ))}
        </ToggleGroup>
      ) : null}

      <div className="flex justify-center" data-field={dataField}>
        <TimeField15 min={min} max={max} value={value} onChange={onChange} aria-label={ariaLabel} />
      </div>
      <FieldError message={error} />
      {beforeEstimate}
      {estimate ? (
        <p className="text-center text-sm text-muted-foreground" data-testid={estimateTestId}>
          <LtrText text={tv(`requestSentence.estimate.${estimate.kind}` as const, { time: estimate.time, minutes: String(estimate.minutes) })} />
        </p>
      ) : null}
    </>
  );
}
