import { tv } from "@/i18n/he";

/** The merged leg in words: the joiner's own pickup / drop-off named ("עין שמר (הורדת עומר)"), every other place as is. */
export function mergeRouteText(points: readonly { name: string; requestId: string | null; kind: string }[], joinerId: string | undefined, joinerName: string): string {
  return points.map((point) => {
    if (!joinerId || point.requestId !== joinerId) return point.name;
    if (point.kind === "board") return tv("mergedRide.resultPickup", { place: point.name, name: joinerName });
    if (point.kind === "alight") return tv("mergedRide.resultDropOff", { place: point.name, name: joinerName });
    return point.name;
  }).join(" ← ");
}
