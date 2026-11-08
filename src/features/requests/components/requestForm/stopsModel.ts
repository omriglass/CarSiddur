// REQUIREMENTS §13.93 "Multi-stop rides" / UX_FLOWS "Stops, built 2026-11-08" (TODO ST1 rework):
// pure logic of the stops editor — ONE ordered list of blocks
// origin -> out stops -> destination -> return stops -> origin (the return part only when the
// trip has a return). The position of a stop decides its leg; the form keeps `outStops` /
// `returnStops`. Return stops stay in form state while hidden (REQ §13.97).
import type { DestinationValue } from "@/components/DestinationCombobox";

import type { PlaceOption } from "./sentence/PlacePicker";

export const MAX_STOPS = 10;

export type StopBlock =
  | { kind: "origin" }
  | { kind: "destination" }
  | { kind: "originEnd" }
  | { kind: "stop"; value: DestinationValue };

export interface StopLists {
  outStops: readonly DestinationValue[];
  returnStops: readonly DestinationValue[];
}

export function toBlocks({ outStops, returnStops }: StopLists, hasReturn: boolean): StopBlock[] {
  return [
    { kind: "origin" },
    ...outStops.map((value) => ({ kind: "stop" as const, value })),
    { kind: "destination" },
    ...(hasReturn ? [...returnStops.map((value) => ({ kind: "stop" as const, value })), { kind: "originEnd" as const }] : []),
  ];
}

/** Back to the form lists. Without a return leg the hidden return stops are passed through untouched. */
export function fromBlocks(blocks: readonly StopBlock[], hasReturn: boolean, hiddenReturnStops: readonly DestinationValue[]): StopLists {
  const destinationAt = blocks.findIndex((b) => b.kind === "destination");
  const stops = (from: number, to: number) =>
    blocks.slice(from, to).flatMap((b) => (b.kind === "stop" ? [b.value] : []));
  return {
    outStops: stops(0, destinationAt),
    returnStops: hasReturn ? stops(destinationAt + 1, blocks.length) : [...hiddenReturnStops],
  };
}

export type Leg = "out" | "return";

/** Leg a block position belongs to (position of a would-be stop, or an existing stop). */
export function legAt(blocks: readonly StopBlock[], index: number): Leg {
  const destinationAt = blocks.findIndex((b) => b.kind === "destination");
  return index <= destinationAt ? "out" : "return";
}

function legCount(blocks: readonly StopBlock[], leg: Leg): number {
  const destinationAt = blocks.findIndex((b) => b.kind === "destination");
  return blocks.filter((b, i) => b.kind === "stop" && (i < destinationAt ? "out" : "return") === leg).length;
}

/** Can a stop be inserted so that it ends up before the block currently at `index` (1..length-1)? */
export function canInsertAt(blocks: readonly StopBlock[], index: number): boolean {
  if (index < 1 || index > blocks.length - 1) return false;
  return legCount(blocks, legAt(blocks, index)) < MAX_STOPS;
}

/** Insert a stop before the block at `index`. */
export function insertStop(blocks: readonly StopBlock[], index: number, value: DestinationValue): StopBlock[] {
  if (!canInsertAt(blocks, index)) return [...blocks];
  return [...blocks.slice(0, index), { kind: "stop", value }, ...blocks.slice(index)];
}

export function removeBlock(blocks: readonly StopBlock[], index: number): StopBlock[] {
  return blocks[index]?.kind === "stop" ? blocks.filter((_, i) => i !== index) : [...blocks];
}

export function replaceStop(blocks: readonly StopBlock[], index: number, value: DestinationValue): StopBlock[] {
  return blocks.map((b, i) => (i === index && b.kind === "stop" ? { kind: "stop", value } : b));
}

/**
 * Move the stop at `from` so it sits before the block that is at `insertBefore` in the CURRENT
 * list (1..length-1; `length-1` = just before the closing block). Refused (list unchanged) when
 * the target leg is full or the move is a no-op.
 */
export function moveStop(blocks: readonly StopBlock[], from: number, insertBefore: number): StopBlock[] {
  const moving = blocks[from];
  if (!moving || moving.kind !== "stop") return [...blocks];
  if (insertBefore < 1 || insertBefore > blocks.length - 1) return [...blocks];
  if (insertBefore === from || insertBefore === from + 1) return [...blocks];
  const rest = blocks.filter((_, i) => i !== from);
  const at = insertBefore > from ? insertBefore - 1 : insertBefore;
  const next = [...rest.slice(0, at), moving, ...rest.slice(at)];
  const sourceLeg = legAt(blocks, from);
  const targetLeg = legAt(next, at);
  if (targetLeg !== sourceLeg && legCount(rest, targetLeg) >= MAX_STOPS) return [...blocks];
  return next;
}

/** One step with the keyboard: -1 up, +1 down (jumps over a fixed block like any other position). */
export function nudgeStop(blocks: readonly StopBlock[], from: number, direction: -1 | 1): StopBlock[] {
  return moveStop(blocks, from, direction < 0 ? from - 1 : from + 2);
}

export function placeName(value: DestinationValue | null | undefined, places: readonly PlaceOption[]): string {
  if (!value) return "";
  if ("presetId" in value) return places.find((d) => d.id === value.presetId)?.name ?? value.name;
  return value.freeText;
}

/** Where the single "+ הוספת עצירה" button inserts: before the destination, else (out leg full) before the closing origin; null = no room. */
export function addPosition(blocks: readonly StopBlock[]): number | null {
  const destinationAt = blocks.findIndex((b) => b.kind === "destination");
  if (canInsertAt(blocks, destinationAt)) return destinationAt;
  const last = blocks.length - 1;
  if (blocks[last]?.kind === "originEnd" && canInsertAt(blocks, last)) return last;
  return null;
}
