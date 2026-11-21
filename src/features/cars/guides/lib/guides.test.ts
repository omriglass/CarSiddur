import { describe, expect, it } from "vitest";

import { cleanSteps, copyCandidates, guideRows, keyMove, missingRequired, moveItem, parseSteps, swipeMove } from "./guides";

const topic = (id: string, position: number, extra: Partial<{ required: boolean; active: boolean }> = {}) =>
  ({ id, title: `t-${id}`, position, required: true, active: true, ...extra });
const guide = (id: string, car_id: string, topic_id: string | null, title = `g-${id}`, steps = [{ text: "a" }]) =>
  ({ id, car_id, topic_id, title, steps });

describe("car guides (REQ item 259)", () => {
  it("reads stored steps, dropping blanks and junk", () => {
    expect(parseSteps([{ text: " one " }, "two", { text: "" }, 3, null])).toEqual([{ text: "one" }, { text: "two" }]);
    expect(parseSteps(null)).toEqual([]);
  });

  it("orders a car's guides: active topics in order (missing rows included), then the rest by title", () => {
    const topics = [topic("b", 2), topic("a", 1), topic("off", 0, { active: false }), topic("opt", 3, { required: false })];
    const guides = [guide("own2", "c", null, "zz"), guide("ga", "c", "a"), guide("own1", "c", null, "aa"), guide("goff", "c", "off", "mm")];
    const rows = guideRows(topics, guides);
    expect(rows.map((r) => (r.kind === "guide" ? r.guide.id : `missing:${r.topic.id}`)))
      .toEqual(["ga", "missing:b", "missing:opt", "own1", "goff", "own2"]);
    expect(missingRequired(rows).map((t) => t.id)).toEqual(["b"]);
  });

  it("offers copies from other cars, same model first", () => {
    const cars = [
      { id: "me", name: "Me", model: "Corolla" },
      { id: "x", name: "Alef", model: "Ioniq" },
      { id: "y", name: "Bet", model: " corolla " },
      { id: "z", name: "Gimel", model: null },
    ];
    const guides = [guide("mine", "me", "t"), guide("gx", "x", "t"), guide("gy", "y", "t"), guide("gz", "z", "t"), guide("other", "x", "u"), guide("empty", "z", "t", "e", [])];
    expect(copyCandidates({ guides, cars, carId: "me", topicId: "t" }).map((c) => [c.guide.id, c.sameModel]))
      .toEqual([["gy", true], ["gx", false], ["gz", false]]);
    expect(copyCandidates({ guides, cars, carId: "me", topicId: null }).map((c) => c.guide.id)).toEqual(["gy", "gx", "other", "gz"]);
  });

  it("moves through steps by swipe and keys, the RTL way", () => {
    expect(swipeMove(80, 5)).toBe("next");
    expect(swipeMove(-80, 5)).toBe("prev");
    expect(swipeMove(20, 0)).toBeNull();
    expect(swipeMove(60, 90)).toBeNull();
    expect(keyMove("ArrowLeft")).toBe("next");
    expect(keyMove("ArrowRight")).toBe("prev");
    expect(keyMove("a")).toBeNull();
  });

  it("cleans and reorders editor steps", () => {
    expect(cleanSteps([" a ", "", "b"])).toEqual([{ text: "a" }, { text: "b" }]);
    expect(moveItem(["a", "b", "c"], 2, -1)).toEqual(["a", "c", "b"]);
    expect(moveItem(["a", "b"], 0, -1)).toEqual(["a", "b"]);
  });
});
