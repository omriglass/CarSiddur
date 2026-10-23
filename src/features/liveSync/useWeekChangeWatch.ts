import { useEffect } from "react";
import { useQueryClient } from "@tanstack/react-query";

import { errorToReport, reportClientError } from "@/features/diagnostics/reportClientError";

import { fetchWeekChangeSeqs } from "./api";
import { invalidateWatchedChange } from "./invalidation";
import { subscribeWeekTopic } from "./realtime";
import { ChangeWatcher, type WatchScope } from "./watcher";

/**
 * Test/diagnostic hook on `<html>`: `data-live-sync="live|polling"` (every live channel of the screen
 * joined, or version check only) and `data-live-sync-broadcasts` (broadcasts received this page
 * session). Read by `e2e/live-sync.spec.ts`; harmless to everyone else.
 */
let broadcastCount = 0;
function markLive(live: boolean): void {
  document.documentElement.dataset.liveSync = live ? "live" : "polling";
}

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
        subscribe: (dept, week, watchScope, handlers) =>
          subscribeWeekTopic(dept, week, watchScope, {
            onStatus: handlers.onStatus,
            onChange: (seq) => {
              broadcastCount += 1;
              document.documentElement.dataset.liveSyncBroadcasts = String(broadcastCount);
              handlers.onChange(seq);
            },
          }),
        // Once per page session (watcher.ts): shows on /admin/errors when the plan's connection limit is hit.
        reportRefusal: (detail) => reportClientError(errorToReport(`realtime_channel_refused: ${detail}`, "liveSync")),
        onLiveState: markLive,
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
