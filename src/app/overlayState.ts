import { useCallback } from "react";
import { useLocation, useNavigate } from "react-router-dom";

import { readLandingPath } from "./landing";
import { paths } from "./routes";

/**
 * The sentence-layout request form opens as an overlay on top of the page the member came from
 * (UX_FLOWS §3.4a, REQ §13.110 a). In-app callers of `paths.requests.new/edit` pass
 * `state={{ from }}` (`useRequestLinkProps()`); a direct load or deep link has no `from` and
 * falls back to the landing page logic (`landing.ts`).
 */
export interface RequestOverlayState {
  from?: string;
}

export function readOverlayFrom(state: unknown): string | undefined {
  if (!state || typeof state !== "object") return undefined;
  const from = (state as RequestOverlayState).from;
  return typeof from === "string" && from.startsWith("/") && !from.startsWith("/requests/") ? from : undefined;
}

/** The page rendered underneath the overlay. */
export function overlayBackgroundPath(state: unknown): string {
  return readOverlayFrom(state) ?? readLandingPath();
}

/**
 * Props for a `<Link>` / `navigate(..., { state })` that opens the request form: remembers the
 * current page as the one underneath. Inside the overlay itself (template suggestion links) the
 * original `from` is kept and the history entry is replaced, so closing still returns to it.
 */
export function useRequestLinkProps(): { state: RequestOverlayState; replace: boolean } {
  const location = useLocation();
  const inOverlay = location.pathname.startsWith("/requests/");
  if (inOverlay) {
    const from = readOverlayFrom(location.state);
    return { state: from ? { from } : {}, replace: true };
  }
  return { state: { from: location.pathname + location.search }, replace: false };
}

/** The request a submit just saved: the page underneath opens on its day. */
export interface RequestOverlayTarget {
  departmentId: string;
  weekStart: string;
  /** `yyyy-MM-dd` */
  day: string;
  /** The siddur shows this week's days (published, live or archived); an open week is only a "not published yet" note. */
  weekOnSiddur: boolean;
}

/** The week phases whose days the siddur shows (the others are a "not published yet" note). */
export function weekShownOnSiddur(phase: string | null | undefined): boolean {
  return phase === "published" || phase === "live" || phase === "archived";
}

/**
 * The background page showing `target`'s day (owner 2026-11-02: after a submit the member stays on the request's
 * day, not the week's default one): the siddur opens that week on `?day=` (when it shows that week at all), the /my
 * week view on that week. `undefined` when the background page has no day to open (the /my list, the archive, a
 * siddur that does not show the request's week).
 */
export function overlayTargetPath(background: string, target: RequestOverlayTarget): string | undefined {
  const url = new URL(background, "http://app.local");
  if (url.pathname.startsWith("/siddur") && !url.pathname.endsWith("/archive")) {
    if (!target.weekOnSiddur) return undefined;
    return paths.siddur({ dept: target.departmentId, week: target.weekStart, day: target.day });
  }
  if (url.pathname === "/my" && url.searchParams.get("view") === "week") {
    url.searchParams.set("week", target.weekStart);
    return `${url.pathname}${url.search}`;
  }
  return undefined;
}

/**
 * Closes the overlay: back in history when the entry is ours, else straight to the background page. With a
 * `target` (a saved request) the overlay's entry is replaced by the background page open on that request's day.
 */
export function useCloseRequestOverlay(): (target?: RequestOverlayTarget) => void {
  const location = useLocation();
  const navigate = useNavigate();
  const from = readOverlayFrom(location.state);
  const hasHistory = location.key !== "default";
  return useCallback((target?: RequestOverlayTarget) => {
    const background = from ?? readLandingPath();
    const targetPath = target ? overlayTargetPath(background, target) : undefined;
    if (targetPath) navigate(targetPath, { replace: true });
    else if (from && hasHistory) navigate(-1);
    else navigate(background, { replace: true });
  }, [from, hasHistory, navigate]);
}
