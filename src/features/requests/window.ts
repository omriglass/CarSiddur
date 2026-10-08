import type { RequestStatus, RideStatus, WeekPhase } from "@/lib/enums";

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
 * Draft solver placements remain editable until the submission deadline. On a published/live
 * week a single-day request is editable too (REQ §13.101 f, QM5) until its day has passed;
 * `submit_request` then answers `needs_confirmation: "release_to_waitlist"` when the new hours
 * have no free car. Multi-day series are never editable (`series_edit_not_supported`).
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
  if (isPublishedDayWindow(request.window)) {
    if (request.seriesId) return false;
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
