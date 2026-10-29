import { useEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";

import { errorToReport, reportClientError } from "@/features/diagnostics/reportClientError";

import { registerWatch } from "@/lib/counterGate";
import { refreshedRecently } from "@/lib/ownRefresh";
import { tabId } from "@/lib/tabId";

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
  /**
   * Does this scope's counter fully describe what the viewer reads (default true)? When it does, the
   * week's ride/board queries skip their focus refetch while this watcher runs (`lib/counterGate.ts`).
   * False for a manager on a public-scope screen (draft rides never move `public_seq`) or while the role is unknown.
   */
  gate?: boolean;
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
  const gate = options.gate ?? true;
  // Returning to the tab re-renders the screen: clock-derived marks (now/past, car-now, tight "!") are computed
  // in render from the clock, and the focus refetch that used to re-render it is skipped for counter-covered queries.
  const [, setReturns] = useState(0);

  useEffect(() => {
    if (!departmentId || !weeksKey) return;
    const gateHandle = registerWatch({ departmentId, weeks: weeksKey.split(","), scope, gate });
    const watcher = new ChangeWatcher(
      { departmentId, weeks: weeksKey.split(","), scope, realtime },
      {
        fetchSeqs: async (dept, weekList) => {
          const rows = await fetchWeekChangeSeqs(dept, weekList);
          gateHandle.markReady();
          return rows;
        },
        subscribe: (dept, week, watchScope, handlers) =>
          subscribeWeekTopic(dept, week, watchScope, {
            onStatus: handlers.onStatus,
            onChange: (seq, tab) => {
              broadcastCount += 1;
              document.documentElement.dataset.liveSyncBroadcasts = String(broadcastCount);
              handlers.onChange(seq, tab);
            },
          }),
        // Once per page session (watcher.ts): shows on /admin/errors when the plan's connection limit is hit.
        reportRefusal: (detail) => reportClientError(errorToReport(`realtime_channel_refused: ${detail}`, "liveSync")),
        onLiveState: markLive,
        invalidate: (change) => invalidateWatchedChange(client, departmentId, scope, change),
        isOwnTab: (tab) => tab === tabId(),
        ownChangeRefreshed: (week) => refreshedRecently(departmentId, week),
        isVisible: () => document.visibilityState === "visible",
        random: Math.random,
      },
    );
    const onVisibility = () => {
      const visible = document.visibilityState === "visible";
      if (visible) setReturns((n) => n + 1);
      watcher.setVisible(visible);
    };
    const onOnline = () => watcher.online();
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("online", onOnline);
    watcher.start();
    return () => {
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("online", onOnline);
      watcher.stop();
      gateHandle.unregister();
    };
  }, [client, departmentId, weeksKey, scope, realtime, gate]);
}
