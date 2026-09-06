import { useCallback, useState } from "react";

import { UndoStack, type UndoAction, type UndoResult } from "./undoStack";

export interface UseUndoStackResult<T> {
  push: (action: UndoAction<T>) => void;
  undo: () => Promise<UndoResult<T> | null>;
  canUndo: boolean;
  peekLabel: string | null;
}

/**
 * React binding for the plain `UndoStack` class. The stack instance itself
 * lives in `useState`'s lazy initializer (read only inside event-handler
 * callbacks below, never during render) rather than a `useRef` — this
 * project's `react-hooks/refs` lint rule flags reading `ref.current` during
 * render, which a naive ref-based binding would need to do to expose
 * `canUndo`/`peekLabel`. A small `{ canUndo, peekLabel }` snapshot in state
 * is what actually triggers a re-render when the stack changes.
 */
export function useUndoStack<T = void>(limit = 50): UseUndoStackResult<T> {
  const [stack] = useState(() => new UndoStack<T>(limit));
  const [snapshot, setSnapshot] = useState<{ canUndo: boolean; peekLabel: string | null }>({
    canUndo: false,
    peekLabel: null,
  });

  const sync = useCallback(() => {
    setSnapshot({ canUndo: stack.canUndo, peekLabel: stack.peekLabel() });
  }, [stack]);

  const push = useCallback(
    (action: UndoAction<T>) => {
      stack.push(action);
      sync();
    },
    [stack, sync],
  );

  const undo = useCallback(async () => {
    const result = await stack.undo();
    sync();
    return result;
  }, [stack, sync]);

  return { push, undo, canUndo: snapshot.canUndo, peekLabel: snapshot.peekLabel };
}
