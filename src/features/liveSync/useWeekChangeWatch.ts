import { useEffect } from "react";
import { useQueryClient } from "@tanstack/react-query";

import { fetchWeekChangeSeqs } from "./api";
import { invalidateWatchedChange } from "./invalidation";
import { ChangeWatcher, type WatchScope } from "./watcher";

export interface WeekChangeWatchOptions {
  /** May this screen open live channels (the viewer is a member/Sadran of the department)? Default true. */
  realtime?: boolean;
}

/**
 * Keeps a screen's week data fresh when someone else changes it (REQ item 149; `watcher.ts` has the
 * timings). `scope` is `"sadran"` on Sadran screens (every change of the week) and `"public"` on member
 * screens (only changes members can see). One watcher per mounted screen; it re-targets when the
 * department, the weeks or the scope change.
 */
export function useWeekChangeWatch(
  departmentId: string | undefined,
  weeks: readonly string[],
  scope: WatchScope,
  options: WeekChangeWatchOptions = {},
): void {
  const client = useQueryClient();
  const weeksKey = [...new Set(weeks)].sort().join(",");
  const realtime = options.realtime ?? true;

  useEffect(() => {
    if (!departmentId || !weeksKey) return;
    const watcher = new ChangeWatcher(
      { departmentId, weeks: weeksKey.split(","), scope, realtime },
      {
        fetchSeqs: fetchWeekChangeSeqs,
        invalidate: (change) => void invalidateWatchedChange(client, departmentId, scope, change),
        isVisible: () => document.visibilityState === "visible",
        random: Math.random,
      },
    );
    const onVisibility = () => watcher.setVisible(document.visibilityState === "visible");
    const onOnline = () => watcher.online();
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("online", onOnline);
    watcher.start();
    return () => {
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("online", onOnline);
      watcher.stop();
    };
  }, [client, departmentId, weeksKey, scope, realtime]);
}
