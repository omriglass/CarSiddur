import { CalendarClock, Repeat } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { toast } from "sonner";

import { formatWeekRangeLabel } from "@/components/DateField";
import { EmptyState } from "@/components/EmptyState";
import { Badge } from "@/components/ui/badge";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { PageHeader } from "@/components/PageHeader";
import { CardListSkeleton } from "@/components/skeletons/CardListSkeleton";
import { StatusBadge } from "@/components/StatusBadge";
import { TripSummary } from "@/components/TripSummary";
import { Button } from "@/components/ui/button";
import type { MyRequestRow } from "@/features/requests/api";
import { groupSeries } from "@/features/requests/series";
import { canEditRequest } from "@/features/requests/window";
import { OpenProposalButton } from "@/features/proposals/components/OpenProposalButton";
import { OpenWaitlistGroupButton } from "@/features/waitlist/components/OpenWaitlistGroupButton";
import {
  useCancelRideMutation,
  useClaimFreedSlotMutation,
  useMyFreedSlotOffers,
  useMyRequests,
  useSaveRequestTemplateMutation,
  useSetFreedSlotOptOutMutation,
  useWithdrawFreedSlotClaimMutation,
  useWithdrawRequestMutation,
  useWithdrawAllRequestsMutation,
} from "@/features/requests/hooks";
import { he, t, tv } from "@/i18n/he";
import { describeStatusReason } from "@/lib/statusReason";
import { formatTime } from "@/lib/time";
import { cn } from "@/lib/utils";
import { paths } from "@/app/routes";

// Mirrors freed_slot_candidates()'s own `status in ('waitlisted','denied')` filter
// (supabase/migrations/20260907091100_freed_slots.sql) — only these statuses are ever
// eligible to be offered a freed slot, so the opt-out toggle is only meaningful here.
const FREED_SLOT_ELIGIBLE_STATUSES = new Set<MyRequestRow["status"]>(["waitlisted", "denied"]);

// "הפוך/י לחוזר" is only meaningful once the request is a real, still-relevant filing —
// mirrors the statuses a repeating request could plausibly resubmit as (REQ §76).
const MAKE_REPEATING_STATUSES = new Set<MyRequestRow["status"]>(["submitted", "assigned"]);

function requestStart(row: MyRequestRow): number {
  const instant = row.ride?.startsAt ?? row.departAt ?? row.returnAt;
  return instant ? new Date(instant).getTime() : Number.POSITIVE_INFINITY;
}

function groupByWeek(rows: DisplayRow[]): { weekStart: string; departmentId: string; rows: DisplayRow[] }[] {
  const byWeek = new Map<string, DisplayRow[]>();
  for (const row of rows) {
    const key = `${row.weekStart}:${row.departmentId}`;
    const list = byWeek.get(key) ?? [];
    list.push(row);
    byWeek.set(key, list);
  }
  return [...byWeek.entries()]
    .sort((a, b) => (a[0] < b[0] ? 1 : -1))
    .map(([, weekRows]) => ({
      weekStart: weekRows[0]!.weekStart,
      departmentId: weekRows[0]!.departmentId,
      rows: weekRows.sort((a, b) => requestStart(a) - requestStart(b) || a.id.localeCompare(b.id)),
    }));
}

/**
 * One "card" per multi-day request ("series", REQ §13.77) — every other leg's fields fold
 * into the first leg's: `returnAt` becomes the LAST leg's return (the full span), `ride`
 * prefers whichever leg is actually assigned (all legs share one car and status once placed,
 * but a fresh submission's legs may not have resolved yet). `seriesLegs` (all legs, day order)
 * marks a display row as a series; withdraw/cancel act on the first leg's id/ride — the
 * server cascades to every day (`withdraw_request`/`cancel_ride`).
 */
interface DisplayRow extends MyRequestRow {
  seriesLegs?: MyRequestRow[];
}

function toDisplayRows(rows: MyRequestRow[]): DisplayRow[] {
  return groupSeries(rows).map((legs): DisplayRow => {
    const first = legs[0]!;
    if (legs.length === 1) return first;
    const last = legs[legs.length - 1]!;
    return {
      ...first,
      returnAt: last.returnAt ?? last.departAt,
      ride: legs.find((leg) => leg.ride)?.ride ?? null,
      seriesLegs: legs,
    };
  });
}

function confirmDialogDescription(action: ConfirmAction | null): string {
  if (!action) return "";
  if (action.kind === "withdrawAll") return he.requestsList.withdrawAllBody;
  const base = action.kind === "withdraw" ? he.request.withdrawConfirmBody : he.rideCoordination.cancelHelp;
  return action.row.seriesLegs ? `${base} ${he.request.seriesCancelBody}` : base;
}

type ConfirmAction =
  | { kind: "withdraw"; row: DisplayRow }
  | { kind: "cancel"; row: DisplayRow }
  | { kind: "withdrawAll"; departmentId: string; weekStart: string };

/** `/requests` — My requests, grouped by week (UX_FLOWS.md §3.3 extended into its own list route). */
export function RequestsListPage() {
  const requestsQuery = useMyRequests();
  const freedOffersQuery = useMyFreedSlotOffers();
  const withdrawMutation = useWithdrawRequestMutation();
  const withdrawAllMutation = useWithdrawAllRequestsMutation();
  const cancelMutation = useCancelRideMutation();
  const claimMutation = useClaimFreedSlotMutation();
  const withdrawClaimMutation = useWithdrawFreedSlotClaimMutation();
  const optOutMutation = useSetFreedSlotOptOutMutation();
  const saveTemplateMutation = useSaveRequestTemplateMutation();

  const [confirmAction, setConfirmAction] = useState<ConfirmAction | null>(null);

  // `?focus=<request_id>` (notification deep link, `notification_default_url`'s
  // `/requests?focus=<id>` case): scroll the matching card into view and ring-highlight it —
  // same pattern as `ProposalsListScreen`'s `?proposal=` highlight.
  const [searchParams] = useSearchParams();
  const focusedId = searchParams.get("focus");
  const highlightedRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (focusedId) highlightedRef.current?.scrollIntoView({ behavior: "smooth", block: "center" });
  }, [focusedId]);

  const rows = requestsQuery.data ?? [];
  const groups = groupByWeek(toDisplayRows(rows));
  const openOffers = (freedOffersQuery.data ?? []).filter(
    (o) => o.offerStatus === "open" && (o.claimStatus === "offered" || o.claimStatus === "claimed"),
  );

  async function runConfirm() {
    if (!confirmAction) return;
    try {
    if (confirmAction.kind === "withdrawAll") {
      await withdrawAllMutation.mutateAsync(confirmAction);
    } else if (confirmAction.kind === "withdraw") {
      await withdrawMutation.mutateAsync({ requestId: confirmAction.row.id, expectedVersion: confirmAction.row.version });
    } else if (confirmAction.row.ride) {
      await cancelMutation.mutateAsync({
        rideId: confirmAction.row.ride.id,
        reason: "CANCELLED_BY_MEMBER",
        expectedVersion: confirmAction.row.ride.version,
      });
    }
    setConfirmAction(null);
    } catch { /* Mutation shows a localized error; keep confirmation open for retry. */ }
  }

  if (requestsQuery.isLoading) {
    return (
      <div className="mx-auto max-w-2xl space-y-6 p-4 pb-24">
        <PageHeader title={he.requestsList.title} />
        <CardListSkeleton />
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-2xl space-y-6 p-4 pb-24">
      <PageHeader title={he.requestsList.title} />

      {openOffers.length > 0 ? (
        <section className="space-y-2">
          <h2 className="text-sm font-semibold text-muted-foreground">{he.freedSlot.title}</h2>
          {openOffers.map((offer) => (
            <div key={offer.offerId} className="space-y-2 rounded-md border border-maintenance/40 bg-maintenance/10 p-3 text-sm">
              <p>
                {tv("requestsList.freedSlotOffer", {
                  car: offer.carName,
                  day: "",
                  depart: formatTime(new Date(offer.startsAt)),
                  return: formatTime(new Date(offer.endsAt)),
                })}
              </p>
              {offer.claimStatus === "offered" ? (
                <Button size="sm" onClick={() => claimMutation.mutate({ offerId: offer.offerId, requestId: offer.requestId })}>
                  {t("action.stillWant")}
                </Button>
              ) : (
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => withdrawClaimMutation.mutate({ offerId: offer.offerId, requestId: offer.requestId })}
                >
                  {he.requestsList.withdrawClaim}
                </Button>
              )}
            </div>
          ))}
        </section>
      ) : null}

      {groups.length === 0 ? (
        <EmptyState icon={CalendarClock} message={he.requestsList.empty} />
      ) : (
        groups.map(({ weekStart, departmentId, rows: weekRows }) => (
          <section key={`${weekStart}:${departmentId}`} className="space-y-2">
            <h2 className="text-sm font-semibold text-muted-foreground" dir="ltr">
              {formatWeekRangeLabel(weekStart)}
            </h2>
            {weekRows.some((row) => canEditRequest(row)) ? (
              <Button size="sm" variant="outline" onClick={() => setConfirmAction({ kind: "withdrawAll", departmentId, weekStart })}>
                {he.requestsList.withdrawAll}
              </Button>
            ) : null}
            <div className="space-y-2">
              {weekRows.map((row) => (
                <div
                  key={row.id}
                  ref={row.id === focusedId ? highlightedRef : undefined}
                  data-request-id={row.id}
                  className={cn("space-y-2 rounded-md border p-3 text-sm", row.id === focusedId && "ring-2 ring-primary")}
                >
                  <div className="flex items-start justify-between gap-2">
                    <TripSummary
                      destination={row.destination}
                      purpose={row.rideTypeName}
                      departAt={row.ride?.startsAt ?? row.departAt}
                      returnAt={row.ride?.endsAt ?? row.returnAt}
                    />
                    <div className="flex shrink-0 items-center gap-2">
                      {row.seriesLegs ? <Badge variant="outline">{tv("request.multiDayBadge", { count: String(row.seriesLegs.length) })}</Badge> : null}
                      <StatusBadge kind="request" status={row.status} />
                    </div>
                  </div>
                  {row.ride?.needsDriver ? <p className="text-sm font-medium text-destructive">{he.rideCoordination.missingDriver}</p> : null}
                  {row.preferredCarName ? <p className="text-xs text-muted-foreground">{he.request.preferredCar}: {row.preferredCarName}</p> : null}
                  {row.childNames?.length ? (
                    <p className="text-xs text-muted-foreground">{tv("ridePublicDetails.companions", { names: row.childNames.join(", ") })}</p>
                  ) : null}
                  {row.templateId ? (
                    <p className="flex items-center gap-1 text-xs text-muted-foreground">
                      <Repeat className="size-3.5" aria-hidden="true" />
                      {he.request.repeating}
                    </p>
                  ) : null}
                  {describeStatusReason(row.statusReason) ? (
                    <p className="text-xs text-muted-foreground">{describeStatusReason(row.statusReason)}</p>
                  ) : null}
                  {FREED_SLOT_ELIGIBLE_STATUSES.has(row.status) ? (
                    <label className="flex items-center gap-2 text-xs text-muted-foreground">
                      <input
                        type="checkbox"
                        className="size-4"
                        checked={row.freedSlotOptOut}
                        onChange={(e) => optOutMutation.mutate({ requestId: row.id, optOut: e.target.checked })}
                      />
                      {he.proposalScreen.optOutFreedSlots}
                    </label>
                  ) : null}
                  <div className="flex flex-wrap gap-2 pt-1">
                    {row.status === "proposed" && row.pendingProposal ? (
                      <OpenProposalButton proposalId={row.pendingProposal.id} size="sm" />
                    ) : null}
                    {row.statusReason === "WAITLISTED_CONTESTED" && (row.departAt ?? row.returnAt) ? (
                      <OpenWaitlistGroupButton
                        departmentId={row.departmentId}
                        weekStart={row.weekStart}
                        requestId={row.id}
                        day={(row.departAt ?? row.returnAt) as string}
                      />
                    ) : null}
                    {canEditRequest(row) && !row.seriesLegs ? (
                      <Button asChild size="sm" variant="outline">
                        <Link to={paths.requests.edit(row.id)}>{he.requestsList.edit}</Link>
                      </Button>
                    ) : null}
                    {row.status !== "withdrawn" && row.status !== "cancelled" && !row.ride ? (
                      <Button size="sm" variant="outline" onClick={() => setConfirmAction({ kind: "withdraw", row })}>
                        {he.requestsList.withdraw}
                      </Button>
                    ) : null}
                    {row.ride && row.ride.status !== "cancelled" ? (
                      <Button size="sm" variant="outline" onClick={() => setConfirmAction({ kind: "cancel", row })}>
                        {he.requestsList.cancelRide}
                      </Button>
                    ) : null}
                    {!row.templateId && !row.seriesLegs && MAKE_REPEATING_STATUSES.has(row.status) ? (
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() =>
                          saveTemplateMutation.mutate(row.id, { onSuccess: () => toast.success(he.request.repeatSaved) })
                        }
                      >
                        {he.request.makeRepeating}
                      </Button>
                    ) : null}
                  </div>
                </div>
              ))}
            </div>
          </section>
        ))
      )}

      <ConfirmDialog
        open={!!confirmAction}
        onOpenChange={(open) => !open && setConfirmAction(null)}
        title={confirmAction?.kind === "withdrawAll" ? he.requestsList.withdrawAllTitle : confirmAction?.kind === "withdraw" ? he.request.withdrawConfirmTitle : he.request.cancelConfirmTitle}
        description={confirmDialogDescription(confirmAction)}
        confirmLabel={confirmAction?.kind === "withdrawAll" ? he.requestsList.withdrawAll : confirmAction?.kind === "withdraw" ? he.requestsList.withdraw : he.requestsList.cancelRide}
        destructive
        loading={withdrawMutation.isPending || cancelMutation.isPending || withdrawAllMutation.isPending}
        onConfirm={() => void runConfirm()}
      />
    </div>
  );
}
