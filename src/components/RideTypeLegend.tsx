import { useRideTypeColorClasses } from "@/components/rideTypeColorsContext";

export interface RideTypeLegendOption {
  code: string;
  /** `ride_types.name_he` — seeded DB data, rendered as-is (CLAUDE.md hard rule 3). */
  nameHe: string;
}

interface RideTypeLegendProps {
  /** The department's active ride types, in their sort order. */
  types: readonly RideTypeLegendOption[];
}

/** Small colored-dot legend row above the board/siddur grid, mapping each ride type to its block color (REQ §13.177 b). */
export function RideTypeLegend({ types }: RideTypeLegendProps) {
  const rideTypeColorClasses = useRideTypeColorClasses();
  if (types.length === 0) return null;

  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
      {types.map(({ code, nameHe }) => (
        <span key={code} className="flex items-center gap-1.5">
          <span className={`size-2.5 rounded-full ${rideTypeColorClasses(code).dot}`} aria-hidden="true" />
          {nameHe}
        </span>
      ))}
    </div>
  );
}
