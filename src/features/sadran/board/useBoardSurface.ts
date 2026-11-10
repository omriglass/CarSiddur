import { useEffect } from "react";
import { useBlocker } from "react-router-dom";

import { readOverlayFrom } from "@/app/overlayState";
import { paths } from "@/app/routes";
import { setAppSurface } from "@/lib/appSurface";

/** REQ §13.138 (c): while the board is mounted, its database calls carry `x-app-surface: board` (`lib/appSurface.ts`). */
export function useBoardSurface(): void {
  useEffect(() => {
    setAppSurface("board");
    return () => setAppSurface(null);
  }, []);
}

/**
 * REQ §13.138 (h): leaving this week's Sadran pages (board, composer, publish, …) with unsent drafts or held updates
 * asks first — in the app (`useBlocker`) and when the tab is closed or reloaded (`beforeunload`).
 */
export function useUnsentLeaveGuard(departmentId: string, weekStart: string, pending: number) {
  const weekBase = paths.sadran.board(departmentId, weekStart).replace(/\/board$/, "");
  // REQ §13.207: opening a request in the form from the board ("עריכת נסיעה", "עריכת הבקשה") comes back here - not leaving.
  const blocker = useBlocker(({ nextLocation }) => pending > 0 && !nextLocation.pathname.startsWith(weekBase)
    && !readOverlayFrom(nextLocation.state)?.startsWith(weekBase));
  useEffect(() => {
    if (pending === 0) return undefined;
    const onBeforeUnload = (event: BeforeUnloadEvent) => event.preventDefault();
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, [pending]);
  return blocker;
}
