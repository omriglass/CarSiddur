// src/features/sadran/board/undoStack.ts
//
// Session-only undo stack for the board (UX_FLOWS.md §4.2 "↶ בטל / Ctrl+Z",
// last 50 actions). Each entry is the *reverse* of one already-applied board
// edit (an `edit_ride` call with the previous values) plus a Hebrew-free
// label key the UI resolves to a toast string — this module never imports
// `src/i18n` (CLAUDE.md hard rule 3 stays with the component that renders
// the toast, not this plain data structure).

export interface UndoAction<T> {
  /** Opaque label the caller uses to render "reverted: <label>" (e.g. a ride id or a translation key). */
  label: string;
  /** Performs the reverse of the original edit; returns whatever the caller wants surfaced (e.g. the reverted ride). */
  run: () => Promise<T> | T;
  /**
   * Re-applies the original edit `run()` just reverted, so `undo` followed by
   * `redo` is a no-op on the data. Optional: an action pushed without a
   * `redo` simply leaves nothing to redo once it's undone (the board only
   * supplies one today, the drag/resize/save edit path) rather than the
   * whole stack refusing to work.
   */
  redo?: () => Promise<T> | T;
}

export interface UndoResult<T> {
  label: string;
  result: T;
}

/**
 * Plain (non-React) undo stack — a bounded LIFO of reverse-actions, plus a
 * redo stack of the forward actions `undo()` just reverted. Pushing a new
 * action clears any pending redo (same convention as a text editor: once you
 * make a fresh edit, the old "redo" branch is gone).
 */
export class UndoStack<T = void> {
  private stack: UndoAction<T>[] = [];
  private redoStack: UndoAction<T>[] = [];

  constructor(private readonly limit = 50) {}

  push(action: UndoAction<T>): void {
    this.stack.push(action);
    if (this.stack.length > this.limit) this.stack.shift();
    this.redoStack = [];
  }

  get canUndo(): boolean {
    return this.stack.length > 0;
  }

  get canRedo(): boolean {
    return this.redoStack.length > 0;
  }

  get size(): number {
    return this.stack.length;
  }

  peekLabel(): string | null {
    return this.stack[this.stack.length - 1]?.label ?? null;
  }

  peekRedoLabel(): string | null {
    return this.redoStack[this.redoStack.length - 1]?.label ?? null;
  }

  async undo(): Promise<UndoResult<T> | null> {
    const action = this.stack.pop();
    if (!action) return null;
    const result = await action.run();
    if (action.redo) {
      this.redoStack.push(action);
      if (this.redoStack.length > this.limit) this.redoStack.shift();
    }
    return { label: action.label, result };
  }

  async redo(): Promise<UndoResult<T> | null> {
    const action = this.redoStack.pop();
    if (!action?.redo) return null;
    const result = await action.redo();
    this.stack.push(action);
    return { label: action.label, result };
  }

  clear(): void {
    this.stack = [];
    this.redoStack = [];
  }
}
