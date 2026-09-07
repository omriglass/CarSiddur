// src/lib/rideTypeColors.ts
//
// One tinted-background + strong start-border color per `ride_types.code`
// (visual pass): board ride blocks, the member siddur grid, `RideCard`'s
// icon chip and `UnmetList`'s row icon all read this single map so the same
// ride is colored identically everywhere. Colors are CSS custom properties
// (`--ride-<code>` in `src/index.css`, light + dark) — this module only
// names Tailwind utility classes built on those tokens, never a literal
// color. `ride_types` is a small admin-editable catalog table, not a fixed
// SQL enum (CLAUDE.md's `enums.ts` mirror only applies to real enums), so
// this map is keyed by the five seeded codes (`supabase/seed.sql`) with an
// `"other"` fallback for any future/custom code — never a crash on an
// unknown one.

export interface RideTypeColorClasses {
  /** Tinted block/card background. */
  bg: string;
  /** Strong `border-inline-start` accent (ride blocks, RideCard icon chip). */
  border: string;
  /** Icon/dot foreground. */
  text: string;
  /** Solid dot (legend row). */
  dot: string;
}

const RIDE_TYPE_COLOR_CLASSES: Record<string, RideTypeColorClasses> = {
  work: { bg: "bg-rideWork/15", border: "border-s-rideWork", text: "text-rideWork", dot: "bg-rideWork" },
  childcare: {
    bg: "bg-rideChildcare/15",
    border: "border-s-rideChildcare",
    text: "text-rideChildcare",
    dot: "bg-rideChildcare",
  },
  healthcare: {
    bg: "bg-rideHealthcare/15",
    border: "border-s-rideHealthcare",
    text: "text-rideHealthcare",
    dot: "bg-rideHealthcare",
  },
  errands: {
    bg: "bg-rideErrands/15",
    border: "border-s-rideErrands",
    text: "text-rideErrands",
    dot: "bg-rideErrands",
  },
  other: { bg: "bg-rideOther/15", border: "border-s-rideOther", text: "text-rideOther", dot: "bg-rideOther" },
};

const OTHER_COLOR_CLASSES = RIDE_TYPE_COLOR_CLASSES.other as RideTypeColorClasses;

/** Falls back to `"other"`'s classes for an unknown/missing code. */
export function rideTypeColorClasses(code: string | null | undefined): RideTypeColorClasses {
  return (code && RIDE_TYPE_COLOR_CLASSES[code]) || OTHER_COLOR_CLASSES;
}

/** The five seeded codes, in the order the legend row displays them. */
export const RIDE_TYPE_LEGEND_ORDER = ["work", "childcare", "healthcare", "errands", "other"] as const;
