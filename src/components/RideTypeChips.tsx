import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { t } from "@/i18n/he";

export interface RideTypeOption {
  id: string;
  /** `ride_types.name_he` — seeded DB data, rendered as-is (CLAUDE.md hard rule 3). */
  nameHe: string;
}

interface RideTypeChipsProps {
  types: readonly RideTypeOption[];
  value: string | null;
  onChange: (id: string) => void;
}

/** Single-select ride-type chips (component inventory `RideTypeChips`, UX_FLOWS.md §3.4). */
export function RideTypeChips({ types, value, onChange }: RideTypeChipsProps) {
  return (
    <ToggleGroup
      type="single"
      value={value ?? undefined}
      onValueChange={(next) => {
        if (next) onChange(next);
      }}
      className="flex-wrap justify-start"
      aria-label={t("field.rideType")}
    >
      {types.map((rt) => (
        <ToggleGroupItem key={rt.id} value={rt.id} className="h-11 px-3 text-sm">
          {rt.nameHe}
        </ToggleGroupItem>
      ))}
    </ToggleGroup>
  );
}
