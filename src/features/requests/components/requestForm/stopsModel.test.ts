import { describe, expect, it } from "vitest";

import type { DestinationValue } from "@/components/DestinationCombobox";

import { MAX_STOPS, addPosition, fromBlocks, insertStop, legAt, moveStop, nudgeStop, removeBlock, replaceStop, toBlocks, type StopBlock } from "./stopsModel";

const p = (n: string): DestinationValue => ({ presetId: n, name: n });
const kinds = (blocks: StopBlock[]) => blocks.map((b) => (b.kind === "stop" ? ("presetId" in b.value ? b.value.presetId : "free") : b.kind));

describe("stopsModel", () => {
  it("lists origin, out stops, destination, return stops, origin when there is a return", () => {
    expect(kinds(toBlocks({ outStops: [p("a")], returnStops: [p("b")] }, true))).toEqual(["origin", "a", "destination", "b", "originEnd"]);
  });

  it("omits the return part without a return and keeps hidden return stops on the way back", () => {
    const lists = { outStops: [p("a")], returnStops: [p("h")] };
    const blocks = toBlocks(lists, false);
    expect(kinds(blocks)).toEqual(["origin", "a", "destination"]);
    expect(fromBlocks(blocks, false, lists.returnStops)).toEqual(lists);
  });

  it("round-trips the lists", () => {
    const lists = { outStops: [p("a"), p("b")], returnStops: [p("c")] };
    expect(fromBlocks(toBlocks(lists, true), true, [])).toEqual(lists);
  });

  it("the position decides the leg (dragging across the destination changes the leg)", () => {
    const blocks = toBlocks({ outStops: [p("a")], returnStops: [] }, true); // origin a destination originEnd
    const moved = moveStop(blocks, 1, 3); // before originEnd
    expect(kinds(moved)).toEqual(["origin", "destination", "a", "originEnd"]);
    expect(fromBlocks(moved, true, [])).toEqual({ outStops: [], returnStops: [p("a")] });
    expect(legAt(moved, 2)).toBe("return");
  });

  it("reorders inside a leg and treats no-op moves as unchanged", () => {
    const blocks = toBlocks({ outStops: [p("a"), p("b")], returnStops: [] }, false);
    expect(kinds(moveStop(blocks, 1, 3))).toEqual(["origin", "b", "a", "destination"]);
    expect(moveStop(blocks, 1, 1)).toEqual(blocks);
    expect(moveStop(blocks, 1, 2)).toEqual(blocks);
  });

  it("never moves a fixed block or outside the list", () => {
    const blocks = toBlocks({ outStops: [p("a")], returnStops: [] }, false);
    expect(moveStop(blocks, 0, 2)).toEqual(blocks);
    expect(moveStop(blocks, 1, 0)).toEqual(blocks);
    expect(moveStop(blocks, 1, 9)).toEqual(blocks);
  });

  it("inserts at a position and removes/replaces stops only", () => {
    let blocks = toBlocks({ outStops: [], returnStops: [] }, true);
    blocks = insertStop(blocks, 1, p("a")); // after origin
    blocks = insertStop(blocks, 3, p("r")); // after destination
    expect(kinds(blocks)).toEqual(["origin", "a", "destination", "r", "originEnd"]);
    expect(kinds(replaceStop(blocks, 1, p("z")))).toEqual(["origin", "z", "destination", "r", "originEnd"]);
    expect(kinds(removeBlock(blocks, 2))).toEqual(kinds(blocks));
    expect(kinds(removeBlock(blocks, 3))).toEqual(["origin", "a", "destination", "originEnd"]);
  });

  it("allows at most 10 stops per leg, also when moving between legs", () => {
    const full = Array.from({ length: MAX_STOPS }, (_, i) => p(`o${i}`));
    let blocks = toBlocks({ outStops: full, returnStops: [p("r")] }, true);
    expect(insertStop(blocks, 1, p("x"))).toEqual(blocks);
    blocks = moveStop(blocks, blocks.length - 2, 1); // refused: the out leg is full
    expect(fromBlocks(blocks, true, []).outStops).toHaveLength(MAX_STOPS);
    expect(fromBlocks(blocks, true, []).returnStops).toHaveLength(1);
    expect(insertStop(blocks, blocks.length - 1, p("y"))).not.toEqual(blocks); // return leg has room
  });

  it("nudges one position with the keyboard, hopping over the destination", () => {
    const blocks = toBlocks({ outStops: [p("a")], returnStops: [] }, true);
    const down = nudgeStop(blocks, 1, 1);
    expect(kinds(down)).toEqual(["origin", "destination", "a", "originEnd"]);
    expect(kinds(nudgeStop(down, 2, -1))).toEqual(["origin", "a", "destination", "originEnd"]);
  });

  it("the single add button inserts before the destination, else before the closing origin, else nowhere", () => {
    expect(addPosition(toBlocks({ outStops: [p("a")], returnStops: [] }, true))).toBe(2);
    const full = Array.from({ length: MAX_STOPS }, (_, i) => p(`o${i}`));
    expect(addPosition(toBlocks({ outStops: full, returnStops: [] }, true))).toBe(MAX_STOPS + 2);
    expect(addPosition(toBlocks({ outStops: full, returnStops: [] }, false))).toBeNull();
  });
});
