import { RIDE_TYPE_LEGEND_ORDER, rideTypeColorClasses } from "@/lib/rideTypeColors";

export interface RideTypeLegendOption {
  code: string;
  /** `ride_types.name_he` — seeded DB data, rendered as-is (CLAUDE.md hard rule 3). */
  nameHe: string;
}

interface RideTypeLegendProps {
  types: readonly RideTypeLegendOption[];
}

/** Small colored-dot legend row above the board/siddur grid, mapping each `ride_types.code` to its block color (visual pass). */
export function RideTypeLegend({ types }: RideTypeLegendProps) {
  const byCode = new Map(types.map((t) => [t.code, t.nameHe]));
  const ordered = RIDE_TYPE_LEGEND_ORDER.filter((code) => byCode.has(code));

  if (ordered.length === 0) return null;

  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
      {ordered.map((code) => (
        <span key={code} className="flex items-center gap-1.5">
          <span className={`size-2.5 rounded-full ${rideTypeColorClasses(code).dot}`} aria-hidden="true" />
          {byCode.get(code)}
        </span>
      ))}
    </div>
  );
}
