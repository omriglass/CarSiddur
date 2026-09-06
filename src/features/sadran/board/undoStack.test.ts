import { describe, expect, it, vi } from "vitest";

import { UndoStack } from "./undoStack";

describe("UndoStack", () => {
  it("starts empty", () => {
    const stack = new UndoStack();
    expect(stack.canUndo).toBe(false);
    expect(stack.size).toBe(0);
    expect(stack.peekLabel()).toBeNull();
  });

  it("undoes the most recently pushed action first (LIFO)", async () => {
    const order: string[] = [];
    const stack = new UndoStack();
    stack.push({ label: "first", run: () => void order.push("first") });
    stack.push({ label: "second", run: () => void order.push("second") });

    expect(stack.peekLabel()).toBe("second");
    const first = await stack.undo();
    expect(first?.label).toBe("second");
    const second = await stack.undo();
    expect(second?.label).toBe("first");
    expect(order).toEqual(["second", "first"]);
    expect(stack.canUndo).toBe(false);
  });

  it("returns null when the stack is empty", async () => {
    const stack = new UndoStack();
    expect(await stack.undo()).toBeNull();
  });

  it("awaits an async run() and returns its result", async () => {
    const stack = new UndoStack<number>();
    stack.push({ label: "restore", run: async () => 42 });
    const result = await stack.undo();
    expect(result).toEqual({ label: "restore", result: 42 });
  });

  it("caps the stack at the given limit, dropping the oldest entries", () => {
    const stack = new UndoStack(2);
    const run = vi.fn();
    stack.push({ label: "a", run });
    stack.push({ label: "b", run });
    stack.push({ label: "c", run });
    expect(stack.size).toBe(2);
    expect(stack.peekLabel()).toBe("c");
  });

  it("clear() empties the stack", () => {
    const stack = new UndoStack();
    stack.push({ label: "a", run: () => undefined });
    stack.clear();
    expect(stack.canUndo).toBe(false);
  });
});
