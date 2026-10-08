// UX_FLOWS §3.4a: the member's last four distinct destinations, one tap each, above the search.
import type { DestinationValue } from "@/components/DestinationCombobox";
import { he } from "@/i18n/he";

import { PillChip } from "./PillChip";

interface RecentDestinationChipsProps {
  values: readonly DestinationValue[];
  onPick: (value: DestinationValue) => void;
}

export function RecentDestinationChips({ values, onPick }: RecentDestinationChipsProps) {
  if (values.length === 0) return null;
  return (
    <div className="space-y-1" data-testid="recent-destinations">
      <p className="text-xs text-muted-foreground">{he.requestSentence.recentDestinations}</p>
      <div className="flex flex-wrap gap-1.5">
        {values.map((value) => (
          <PillChip key={"presetId" in value ? value.presetId : `text:${value.freeText}`} onClick={() => onPick(value)}>
            {"presetId" in value ? value.name : value.freeText}
          </PillChip>
        ))}
      </div>
    </div>
  );
}
