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

/** "נגה (הלוך)" / "מעיין (חזור)" for a one-way rider on a ride that carries both directions, else the name as is. */
export function withLegMark(name: string, leg: RideLeg | null | undefined, bothLegs: boolean): string {
  if (!bothLegs || !leg || leg === "both") return name;
  return tv("ridePublicDetails.legMark", { name, leg: leg === "out" ? he.rideRoute.out : he.rideRoute.return });
}
