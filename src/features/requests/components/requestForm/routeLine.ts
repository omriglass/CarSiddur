// REQUIREMENTS §13.93 "Multi-stop rides" / UX_FLOWS "Stops, built 2026-11-08 (TODO ST1)":
// the pure builder behind the live route line ("נבו → חדרה → בנימינה" · "חזרה: …"). Names in,
// ordered hops out; the component renders the words and the × on the stop hops.

import type { DestinationPreset, DestinationValue } from "@/components/DestinationCombobox";

export type StopLeg = "out" | "return";

export interface RouteHop {
  label: string;
  /** Set on a stop hop: which leg's list it belongs to and its position there (for ×). */
  stop?: { leg: StopLeg; index: number };
}

export interface RouteLine {
  out: RouteHop[];
  /** null when the trip has no return leg. */
  back: RouteHop[] | null;
}

export interface RouteLineInput {
  origin: string;
  destination: string;
  outStops: readonly string[];
  returnStops: readonly string[];
  hasReturn: boolean;
}

/** Number of stops that are active on this trip (return stops stay hidden without a return leg, REQ §13.97). */
export function activeStopCount({ outStops, returnStops, hasReturn }: Pick<RouteLineInput, "outStops" | "returnStops" | "hasReturn">): number {
  return outStops.length + (hasReturn ? returnStops.length : 0);
}

export function buildRouteLine(input: RouteLineInput): RouteLine {
  const { origin, destination, outStops, returnStops, hasReturn } = input;
  const out: RouteHop[] = [
    { label: origin },
    ...outStops.map((label, index) => ({ label, stop: { leg: "out" as const, index } })),
    { label: destination },
  ];
  const back: RouteHop[] | null = hasReturn
    ? [
        { label: destination },
        ...returnStops.map((label, index) => ({ label, stop: { leg: "return" as const, index } })),
        { label: origin },
      ]
    : null;
  return { out, back };
}

export function placeName(value: DestinationValue | null | undefined, destinations: readonly DestinationPreset[]): string {
  if (!value) return "";
  if ("presetId" in value) return destinations.find((d) => d.id === value.presetId)?.name ?? value.name;
  return value.freeText;
}
