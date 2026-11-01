// src/lib/rideTypeColors.ts
//
// One tinted-background + strong start-border color per ride type: board ride blocks, the member siddur grid,
// `RideCard`'s icon chip, `UnmetList`'s row icon, the legend and the statistics pie all read this single map so the
// same ride is colored identically everywhere. Colors are CSS custom properties (`--ride-<name>` in `src/index.css`,
// light + dark) — this module only names Tailwind utility classes built on those tokens, never a literal color.
//
// REQ §13.177 (b): the admin picks each type's colour (`ride_types.color`, enum `ride_type_color`). A type with no
// colour falls back by code for the five seeded codes (`supabase/seed.sql`), else gray — never a crash on an
// unknown code. Callers that know the department's catalog pass `colorByCode` (`useRideTypeColors()`).
import type { RideTypeColor } from "@/lib/enums";

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

const COLOR_CLASSES: Record<RideTypeColor, RideTypeColorClasses> = {
  blue: { bg: "bg-rideWork/15", border: "border-s-rideWork", text: "text-rideWork", dot: "bg-rideWork" },
  pink: { bg: "bg-rideChildcare/15", border: "border-s-rideChildcare", text: "text-rideChildcare", dot: "bg-rideChildcare" },
  teal: { bg: "bg-rideHealthcare/15", border: "border-s-rideHealthcare", text: "text-rideHealthcare", dot: "bg-rideHealthcare" },
  orange: { bg: "bg-rideErrands/15", border: "border-s-rideErrands", text: "text-rideErrands", dot: "bg-rideErrands" },
  gray: { bg: "bg-rideOther/15", border: "border-s-rideOther", text: "text-rideOther", dot: "bg-rideOther" },
  green: { bg: "bg-rideGreen/15", border: "border-s-rideGreen", text: "text-rideGreen", dot: "bg-rideGreen" },
  yellow: { bg: "bg-rideYellow/15", border: "border-s-rideYellow", text: "text-rideYellow", dot: "bg-rideYellow" },
  red: { bg: "bg-rideRed/15", border: "border-s-rideRed", text: "text-rideRed", dot: "bg-rideRed" },
};

const SEEDED_CODE_COLORS: Record<string, RideTypeColor> = {
  work: "blue",
  childcare: "pink",
  healthcare: "teal",
  errands: "orange",
  other: "gray",
};

/** The colour a type shows: its own, else by seeded code, else gray. */
export function rideTypeColorOf(code: string | null | undefined, colorByCode?: ReadonlyMap<string, RideTypeColor | null>): RideTypeColor {
  return (code && (colorByCode?.get(code) ?? SEEDED_CODE_COLORS[code])) || "gray";
}

export function rideTypeColorClasses(code: string | null | undefined, colorByCode?: ReadonlyMap<string, RideTypeColor | null>): RideTypeColorClasses {
  return COLOR_CLASSES[rideTypeColorOf(code, colorByCode)];
}

/** The classes of one palette colour (the admin's colour picker). */
export function colorClasses(color: RideTypeColor): RideTypeColorClasses {
  return COLOR_CLASSES[color];
}
