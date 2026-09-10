import { describe, expect, it } from "vitest";

import { orderedSelection } from "./orderedSelection";

describe("orderedSelection", () => {
  it("puts the driver first, preserving the order of everybody else", () => {
    expect(orderedSelection(["a", "b", "c"], "b")).toEqual(["b", "a", "c"]);
  });

  it("is a no-op when the driver is already first", () => {
    expect(orderedSelection(["a", "b"], "a")).toEqual(["a", "b"]);
  });

  it("returns the ticked list unchanged when there is no driver", () => {
    expect(orderedSelection(["a", "b"], null)).toEqual(["a", "b"]);
  });

  it("returns the ticked list unchanged when the driver isn't ticked", () => {
    expect(orderedSelection(["a", "b"], "z")).toEqual(["a", "b"]);
  });

  it("handles a single ticked member", () => {
    expect(orderedSelection(["a"], "a")).toEqual(["a"]);
  });
});
