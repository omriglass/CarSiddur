// UX_FLOWS §3.4a: one "± גמישות" chip row per time (בדיוק · ¼ ש׳ · ½ ש׳ · שעה · שעתיים · כל היום)
// writing the SAME value to the earlier and later field of that end, plus a link that shows the
// two existing `FlexibilitySegmented` rows when earlier and later must differ.
import { useState } from "react";

import { FlexibilitySegmented } from "@/components/FlexibilitySegmented";
import { FLEX_VALUES, type FlexValue } from "@/components/flexibilityValues";
import { Button } from "@/components/ui/button";
import { he } from "@/i18n/he";

import { PillChip } from "./PillChip";
import { mergeFlex, sharedFlexValue } from "./sentenceModel";

interface FlexibilityRowProps {
  early: FlexValue;
  late: FlexValue;
  onChange: (early: FlexValue, late: FlexValue) => void;
  /** react-hook-form field name of the earlier value (`useScrollToFirstError` anchor). */
  dataField: string;
  hint?: boolean;
}

export function FlexibilityRow({ early, late, onChange, dataField, hint = true }: FlexibilityRowProps) {
  // A stored early != late opens in split mode; the member can switch either way afterwards.
  const [split, setSplit] = useState(() => sharedFlexValue(early, late) === null);
  const shared = sharedFlexValue(early, late);

  return (
    <div className="space-y-1.5" data-field={dataField}>
      <p className="text-sm font-medium">{he.requestSentence.flexRowLabel}</p>
      {split ? (
        <div className="space-y-1.5">
          <div>
            <span className="text-xs text-muted-foreground">{he.requestSentence.flexEarlier}</span>
            <FlexibilitySegmented value={early} onChange={(value) => onChange(value, late)} aria-label={he.requestSentence.flexEarlier} />
          </div>
          <div>
            <span className="text-xs text-muted-foreground">{he.requestSentence.flexLater}</span>
            <FlexibilitySegmented value={late} onChange={(value) => onChange(early, value)} aria-label={he.requestSentence.flexLater} />
          </div>
        </div>
      ) : (
        <div className="flex flex-wrap gap-1 [&>button]:px-2 [&>button]:text-xs" role="group" aria-label={he.requestSentence.flexRowLabel}>
          {FLEX_VALUES.map((flex) => (
            <PillChip key={flex} pressed={shared === flex} onClick={() => onChange(flex, flex)}>
              {he.requestSentence.flexChip[String(flex) as keyof typeof he.requestSentence.flexChip]}
            </PillChip>
          ))}
        </div>
      )}
      <Button
        type="button"
        variant="link"
        size="sm"
        className="h-auto px-0 py-0 text-xs"
        onClick={() => {
          if (split && shared === null) onChange(mergeFlex(early, late), mergeFlex(early, late));
          setSplit(!split);
        }}
      >
        {split ? he.requestSentence.flexSameLink : he.requestSentence.flexSplitLink}
      </Button>
      {hint ? <p className="text-xs text-muted-foreground">{he.request.flexibilityHelper}</p> : null}
    </div>
  );
}
