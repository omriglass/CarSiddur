// UX_FLOWS §3.4a: the body of the origin / destination / stop sheets — recent chips on top, an
// inline search over the department's places (travel minutes instead of the zone code), the
// free-text row last. The classic form keeps `DestinationCombobox` (popover) unchanged.
import type { DestinationValue } from "@/components/DestinationCombobox";
import { filterDestinations } from "@/components/destinationFilter";
import { he, tv } from "@/i18n/he";

import { InlineSearchList } from "./InlineSearchList";
import { RecentDestinationChips } from "./RecentDestinationChips";

export interface PlaceOption {
  id: string;
  name: string;
  aliases: readonly string[];
  zone?: string;
  travelMinutes?: number | null;
  /** Replaces the travel-minutes hint (plan B marks drop points). */
  tag?: string;
}

interface PlacePickerProps {
  places: readonly PlaceOption[];
  value: DestinationValue | null;
  onPick: (value: DestinationValue) => void;
  placeholder: string;
  recent?: readonly DestinationValue[];
}

export function PlacePicker({ places, value, onPick, placeholder, recent }: PlacePickerProps) {
  const byId = new Map(places.map((place) => [place.id, place]));
  return (
    <div className="space-y-3">
      {recent && recent.length > 0 ? <RecentDestinationChips values={recent} onPick={onPick} /> : null}
      <InlineSearchList
        placeholder={placeholder}
        getItems={(query) =>
          filterDestinations(places, query).map((place) => ({
            key: place.id,
            label: place.name,
            selected: !!value && "presetId" in value && value.presetId === place.id,
            hint: place.tag ?? (place.travelMinutes ? <><span dir="ltr">{place.travelMinutes}</span> {he.requestSentence.minutesUnit}</> : undefined),
          }))
        }
        onSelect={(id) => {
          const place = byId.get(id);
          if (place) onPick({ presetId: place.id, name: place.name });
        }}
        freeText={{ label: (text) => tv("requestSentence.placeFreeText", { text }), onSelect: (text) => onPick({ freeText: text }) }}
      />
    </div>
  );
}
