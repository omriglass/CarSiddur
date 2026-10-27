import type { RequestStatus, RideStatus, WeekPhase } from "@/lib/enums";
import { dateKey } from "@/lib/time";

export interface RequestWindow {
  phase: WeekPhase;
  open_at: string;
  close_at: string;
  /** `weeks.published_days` (Jerusalem date keys) — the days a member may see outcomes for (REQ §13.109 a). */
  published_days?: string[];
}

export function isRequestWindowOpen(window: RequestWindow | null | undefined, now = Date.now()): boolean {
  return !!window && (window.phase === "open" || window.phase === "solving") && now >= Date.parse(window.open_at) && now <= Date.parse(window.close_at);
}


/** A published/live week: its days are public, so an edit goes through the release-to-waitlist flow (REQ §13.101 f). */
export function isPublishedDayWindow(window: RequestWindow | null | undefined): boolean {
  return !!window && (window.phase === "published" || window.phase === "live");
}

/**
 * REQ §13.155 (R15U1, owner 2026-10-27): the request falls on a day of a partly published week that is not published
 * yet — members may not file, edit or cancel there (`submit_request` answers `day_not_published`), so /my hides both.
 * Its first and last day both count (a multi-day request spanning such a day is refused too).
 */
export function isOnUnpublishedDay(request: { window?: RequestWindow | null; departAt?: string | null; returnAt?: string | null }): boolean {
  const days = request.window?.published_days ?? [];
  if (!isPublishedDayWindow(request.window) || days.length === 0) return false;
  return [request.departAt, request.returnAt].some((at) => !!at && !days.includes(dateKey(at)));
}

/**
 * Draft solver placements remain editable until the submission deadline. On a published/live
 * week a single-day request is editable too (REQ §13.101 f, QM5) until its day has passed;
 * `submit_request` then answers `edit_refused` (nothing changed) when no car takes the new hours —
 * an edit never costs the car (REQ §13.158). A multi-day series is edited as a whole on the same terms (REQ §13.142,
 * `submit_series_request` with `series_id`; R13B3).
 */
export function canEditRequest(request: {
  status: RequestStatus;
  window?: RequestWindow | null;
  hasPublishedRide?: boolean;
  ride?: { status: RideStatus } | null;
  seriesId?: string | null;
  /** REQ §13.112 (a): a request now served by its plan B is not edited (`request_not_editable`). */
  servedByAlternative?: boolean;
  departAt?: string | null;
  returnAt?: string | null;
}, now = Date.now()): boolean {
  if (["withdrawn", "cancelled"].includes(request.status)) return false;
  if (request.servedByAlternative) return false;
  if (isOnUnpublishedDay(request)) return false;
  if (isPublishedDayWindow(request.window)) {
    const end = Math.max(
      request.departAt ? Date.parse(request.departAt) : Number.NEGATIVE_INFINITY,
      request.returnAt ? Date.parse(request.returnAt) : Number.NEGATIVE_INFINITY,
    );
    return Number.isFinite(end) && end > now;
  }
  return isRequestWindowOpen(request.window, now)
    && !request.hasPublishedRide
    && (!request.ride || request.ride.status === "draft" || request.ride.status === "cancelled");
}
