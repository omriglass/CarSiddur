// TODO UN1 (owner 2026-11-08): every board action can be undone. Any action is recorded the same way: take the
// caller's audit marker on the week, run the action, collect the transactions it wrote (`board_changes_since`) and
// push one undo entry that reverses them on the server (`undo_board_change`, newest first). Each undo returns its own
// transactions, so undoing those again is the redo. Components inside the board reach the recorder through
// `BoardUndoContext`; outside the board (siddur, /my) the default just runs the action.
import { createContext, useCallback, useContext } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";

import { invalidateWeekData } from "@/features/rides/invalidateWeek";
import { he, tv } from "@/i18n/he";
import { showErrorToast } from "@/lib/rpc";

import { boardChangesSince, undoBoardChange } from "../api";
import type { UndoAction } from "./undoStack";

export type RecordBoardUndo = <T>(label: string, action: () => Promise<T>, options?: { toast?: string }) => Promise<T>;

const passThrough: RecordBoardUndo = (_label, action) => action();

export const BoardUndoContext = createContext<RecordBoardUndo>(passThrough);

/** The board's undo recorder (a pass-through outside the board). */
export function useRecordBoardUndo(): RecordBoardUndo {
  return useContext(BoardUndoContext);
}

/** The entry that flips `txids` back and forth on the server: run = undo, redo = undo of that undo. A refusal is shown. */
export function boardUndoEntry(label: string, txids: readonly number[], undo: (txids: readonly number[]) => Promise<number>, after: () => void): UndoAction<void> {
  let applied: readonly number[] = [...txids];
  const flip = async () => {
    try {
      applied = [await undo(applied)];
    } catch (error) {
      showErrorToast(error);
      throw error;
    } finally {
      after();
    }
  };
  return { label, run: flip, redo: flip };
}

export function useBoardUndoRecorder(departmentId: string, weekStart: string, stack: {
  push: (action: UndoAction<void>) => void;
  undoEntry: (action: UndoAction<void>) => Promise<{ label: string } | null>;
}): RecordBoardUndo {
  const queryClient = useQueryClient();
  const { push, undoEntry } = stack;
  return useCallback<RecordBoardUndo>(async (label, action, options) => {
    const before = await boardChangesSince(departmentId, weekStart).catch(() => null);
    const result = await action();
    if (!before) return result;
    const txids = await boardChangesSince(departmentId, weekStart, before.marker).then((changes) => changes.txids).catch(() => []);
    if (txids.length === 0) return result;
    const entry = boardUndoEntry(label, txids, (ids) => undoBoardChange(departmentId, weekStart, ids),
      () => invalidateWeekData(queryClient, departmentId, weekStart));
    push(entry);
    if (options?.toast) {
      toast.success(options.toast, {
        action: { label: he.common.cancel, onClick: () => {
          void undoEntry(entry).then((undone) => { if (undone) toast.success(tv("sadranBoard.undoToast", { label: undone.label })); }).catch(() => undefined);
        } },
      });
    }
    return result;
  }, [departmentId, weekStart, push, undoEntry, queryClient]);
}
