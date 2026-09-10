import { useState } from "react";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { he } from "@/i18n/he";

/** The six flexibility values every request field offers (REQUIREMENTS §5.3, UX_FLOWS.md §3.4). */
export const FLEX_VALUES = [0, 15, 30, 60, 120, "any"] as const;

export type FlexValue = (typeof FLEX_VALUES)[number];

const LABEL_BY_VALUE: Record<FlexValue, string> = {
  0: he.flex["0"],
  15: he.flex["15"],
  30: he.flex["30"],
  60: he.flex["60"],
  120: he.flex["120"],
  any: he.flex.anyTime,
};

interface FlexibilitySegmentedProps {
  value: FlexValue;
  onChange: (value: FlexValue) => void;
  "aria-label"?: string;
  /** react-hook-form field name, for `useScrollToFirstError` to find this control on an invalid submit. */
  "data-field"?: string;
}

/** Six-option compact segmented control, used ×4 in the request form (component inventory). */
export function FlexibilitySegmented({ value, onChange, ...rest }: FlexibilitySegmentedProps) {
  return (
    <ToggleGroup
      {...rest}
      type="single"
      value={String(value)}
      onValueChange={(next) => {
        if (!next) return; // toggle-group allows deselecting to "" — ignore
        const parsed = FLEX_VALUES.find((flex) => String(flex) === next);
        if (parsed !== undefined) onChange(parsed);
      }}
      className="flex-wrap justify-start"
    >
      {FLEX_VALUES.map((flex) => (
        <ToggleGroupItem
          key={flex}
          value={String(flex)}
          className="h-11 min-w-11 px-2 text-xs"
          aria-label={LABEL_BY_VALUE[flex]}
        >
          {LABEL_BY_VALUE[flex]}
        </ToggleGroupItem>
      ))}
    </ToggleGroup>
  );
}


type FlexDirection = "both" | "later" | "earlier";

/** Compact direction + amount, persisted through the existing early/late fields. */
export function FlexibilityRange({ early, late, onChange, dataField }: {
  early: FlexValue;
  late: FlexValue;
  onChange: (early: FlexValue, late: FlexValue) => void;
  /** react-hook-form field name, for `useScrollToFirstError` to find this control on an invalid submit. */
  dataField?: string;
}) {
  const [zeroDirection, setZeroDirection] = useState<FlexDirection>("both");
  const direction: FlexDirection = early === 0 && late === 0 ? zeroDirection : early === 0 ? "later" : late === 0 ? "earlier" : "both";
  const amount: FlexValue = early === "any" || late === "any" ? "any" : Math.max(early, late) as FlexValue;
  function change(nextDirection: FlexDirection, nextAmount: FlexValue) {
    setZeroDirection(nextDirection);
    onChange(nextDirection === "later" ? 0 : nextAmount, nextDirection === "earlier" ? 0 : nextAmount);
  }
  return (
    <div className="space-y-1" data-field={dataField}>
      <ToggleGroup type="single" value={direction} aria-label={he.request.flexDirection}
        onValueChange={(next) => { if (next) change(next as FlexDirection, amount); }} className="justify-start" dir="ltr">
        <ToggleGroupItem value="both" aria-label={he.request.flexBoth}>±</ToggleGroupItem>
        <ToggleGroupItem value="later" aria-label={he.request.flexLater}>+</ToggleGroupItem>
        <ToggleGroupItem value="earlier" aria-label={he.request.flexEarlier}>−</ToggleGroupItem>
      </ToggleGroup>
      {direction === "both" && early !== late ? (
        <div>
          <FlexibilitySegmented value={early} onChange={(value) => onChange(value, late)} aria-label={he.flex.earlier} />
          <FlexibilitySegmented value={late} onChange={(value) => onChange(early, value)} aria-label={he.flex.later} />
        </div>
      ) : <FlexibilitySegmented value={amount} onChange={(value) => change(direction, value)} />}
    </div>
  );
}
