import { toast } from "sonner";

import { t, tv } from "@/i18n/he";

import type { SubmitRequestResult, SubmitSeriesRequestResult } from "./api";

export interface SubmitOutcomeContext {
  /** Resolves a `cars.id` to its display name (both variants already have `carsQuery.data`). */
  carName: (id: string | null | undefined) => string;
  /** The requester's own preferred/requested car, for the "assigned to a different car" case. */
  preferredCarId?: string | null;
  departTime?: string;
  returnTime?: string;
  /** Shown as the waitlisted toast's action link (My requests). */
  onViewRequests?: () => void;
}

/**
 * One outcome toast for `submit_request`/`enter_waiting_list`'s result, shared by both
 * `RequestForm` variants (weekly and quick, UX_FLOWS.md §3.4/§18/§21) so a case added to one
 * automatically covers the other. A plain weekly submission against an open/solving week has
 * no `status` on its result (`try_auto_approve` never ran) — every branch below is guarded on a
 * field that is only ever present once the RPC actually resolved a live/published-week outcome,
 * so that case falls through silently, unchanged from before this consolidation.
 */
export function toastSubmitOutcome(result: SubmitRequestResult | null | undefined, ctx: SubmitOutcomeContext): void {
  if (!result) return;

  if (result.car_was_free) {
    toast.success(tv("quickRequest.successCarWasFree", { car: ctx.carName(result.car_id) }));
    return;
  }

  if (result.needs_driver && result.ride_id && result.car_id) {
    toast.success(tv("quickRequest.successNeedsDriver", { car: ctx.carName(result.car_id) }));
    return;
  }

  if (result.status === "assigned" && result.car_id) {
    if (result.car_id === ctx.preferredCarId) {
      toast.success(tv("quickRequest.successAssigned", { car: ctx.carName(result.car_id), start: ctx.departTime ?? "", end: ctx.returnTime ?? "" }));
    } else {
      toast.success(tv("quickRequest.successFallback", { car: ctx.carName(result.car_id), preferredCar: ctx.carName(ctx.preferredCarId) }));
    }
    return;
  }

  if (result.status === "waitlisted") {
    toast(t("quickRequest.waitlisted"), {
      action: ctx.onViewRequests ? { label: t("quickRequest.waitlistedLink"), onClick: ctx.onViewRequests } : undefined,
    });
  }
}

/**
 * F4 (docs/TODO.md, owner answers A8-A10, 2026-09-14): should `RequestForm.performSubmit` even
 * bother calling `joinable_rides_for_request`? Only for a genuine waiting-list outcome — the
 * same field `toastSubmitOutcome`'s own `waitlisted` branch reads (present only once
 * `try_auto_approve()`/`enter_waiting_list()` has actually run, i.e. a published/live week), so
 * this can never fire when `toastSubmitOutcome` stayed silent (open/solving week) or reported a
 * different outcome (assigned, needs-driver, car-was-free).
 */
export function shouldOfferJoinableRides(result: SubmitRequestResult | null | undefined): boolean {
  return result?.status === "waitlisted";
}

/**
 * `submit_series_request`'s outcome toast (multi-day request, REQ §13.77, UX_FLOWS.md §3.4).
 * Same "falls through silently against an open/solving week" shape as `toastSubmitOutcome`
 * above — `status` is only present once `try_auto_approve_series()` actually ran.
 */
export function toastSeriesSubmitOutcome(result: SubmitSeriesRequestResult | null | undefined): void {
  if (!result) return;

  if (result.status === "assigned") {
    toast.success(t("request.seriesAssigned"));
    return;
  }

  if (result.status === "waitlisted") {
    toast(t("request.seriesWaitlisted"));
  }
}
