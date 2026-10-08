import { useCallback } from "react";
import { useLocation, useNavigate } from "react-router-dom";

import { readLandingPath } from "./landing";

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

/** Closes the overlay: back in history when the entry is ours, else straight to the background page. */
export function useCloseRequestOverlay(): () => void {
  const location = useLocation();
  const navigate = useNavigate();
  const from = readOverlayFrom(location.state);
  const hasHistory = location.key !== "default";
  return useCallback(() => {
    if (from && hasHistory) navigate(-1);
    else navigate(from ?? readLandingPath(), { replace: true });
  }, [from, hasHistory, navigate]);
}
