import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { t } from "@/i18n/he";
import { rideTypeColorClasses } from "@/lib/rideTypeColors";
import { cn } from "@/lib/utils";

export interface RideTypeOption {
  id: string;
  /** `ride_types.name_he` — seeded DB data, rendered as-is (CLAUDE.md hard rule 3). */
  nameHe: string;
  /** `ride_types.code` — with `dots`, picks the colour dot (`rideTypeColorClasses`). */
  code?: string | null;
}

interface RideTypeChipsProps {
  types: readonly RideTypeOption[];
  value: string | null;
  onChange: (id: string) => void;
  /** Sentence layout (UX_FLOWS §3.4a): a ride-type colour dot before each name. */
  dots?: boolean;
}

/** Single-select ride-type chips (component inventory `RideTypeChips`, UX_FLOWS.md §3.4). */
export function RideTypeChips({ types, value, onChange, dots }: RideTypeChipsProps) {
  return (
    <ToggleGroup
      type="single"
      value={value ?? undefined}
      onValueChange={(next) => {
        if (next) onChange(next);
      }}
      className={cn("flex-wrap justify-start", dots && "gap-1.5")}
      aria-label={t("field.rideType")}
    >
      {types.map((rt) => (
        <ToggleGroupItem
          key={rt.id}
          value={rt.id}
          className={cn(
            "h-11 px-3 text-sm",
            // Sentence layout: bordered pills, the selected one tinted (an unselected chip must still read as a chip).
            dots && "h-8 rounded-full border px-3 data-[state=on]:border-primary data-[state=on]:bg-primary/10 data-[state=on]:font-medium data-[state=on]:text-primary",
          )}
        >
          {dots ? <span className={cn("me-1.5 inline-block size-2.5 rounded-full", rideTypeColorClasses(rt.code).dot)} aria-hidden="true" /> : null}
          {rt.nameHe}
        </ToggleGroupItem>
      ))}
    </ToggleGroup>
  );
}
