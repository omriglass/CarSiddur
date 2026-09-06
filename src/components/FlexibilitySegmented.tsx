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
