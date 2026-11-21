import { he, tv } from "@/i18n/he";

export type RideLeg = "out" | "return" | "both";

/**
 * REQ §13.178: a ride carries both directions when one of its served requests rides both legs, or it serves
 * an out leg and a return leg together — only then is a one-way rider marked. A ride of one leg (a relay leg,
 * a chauffeur pickup) marks nobody; a ride with no served request (a reservation) marks its added people's legs.
 */
export function rideCarriesBothLegs(servedLegs: readonly (RideLeg | null | undefined)[]): boolean {
  const legs = servedLegs.filter((leg): leg is RideLeg => !!leg);
  return legs.length === 0 || legs.includes("both") || (legs.includes("out") && legs.includes("return"));
}

export interface LegName { name: string; leg: RideLeg | null | undefined }

/**
 * RP1 (owner 2026-11-20): on a ride that carries both directions with someone riding one way only, the names split by
 * leg — everyone riding out, everyone riding back (a both-ways rider is on both). Null when nobody needs splitting: the
 * names then read as one list, unmarked.
 */
export function namesByLeg(items: readonly LegName[], bothLegs: boolean): { out: string[]; ret: string[] } | null {
  if (!bothLegs || !items.some((item) => item.leg === "out" || item.leg === "return")) return null;
  return {
    out: items.filter((item) => item.leg !== "return").map((item) => item.name),
    ret: items.filter((item) => item.leg !== "out").map((item) => item.name),
  };
}

/** "הלוך: א, ב" / "חזור: א, ג" — the lines with someone on them. */
export function legLines(byLeg: { out: readonly string[]; ret: readonly string[] }, join: (names: readonly string[]) => string = (names) => names.join(", ")): string[] {
  return [
    ...(byLeg.out.length ? [tv("ridePublicDetails.legOutLine", { names: join(byLeg.out) })] : []),
    ...(byLeg.ret.length ? [tv("ridePublicDetails.legReturnLine", { names: join(byLeg.ret) })] : []),
  ];
}

/** "נגה (הלוך)" / "מעיין (חזור)" for a one-way rider on a ride that carries both directions, else the name as is. */
export function withLegMark(name: string, leg: RideLeg | null | undefined, bothLegs: boolean): string {
  if (!bothLegs || !leg || leg === "both") return name;
  return tv("ridePublicDetails.legMark", { name, leg: leg === "out" ? he.rideRoute.out : he.rideRoute.return });
}
