// R9B2 / REQ §13.77: `/requests/:id/edit` of a multi-day request ("series" leg). A series is never
// edited — only shortened or cancelled — so instead of a misleading single-day form this panel
// shows the span and the two actions `/my` already has (shorten, cancel/withdraw), reusing the
// same dialog, mutations and confirmation copy.
import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";

import { paths } from "@/app/routes";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { TripSummary } from "@/components/TripSummary";
import { Button } from "@/components/ui/button";
import { he, tv } from "@/i18n/he";
import { formatDayDate } from "@/lib/dayLabels";

import { useCancelRideMutation, useMyRequests, useWithdrawRequestMutation } from "../hooks";
import { confirmDialogDescription, confirmDialogLabel, confirmDialogTitle, toDisplayRows, type ConfirmAction } from "../myRequestsRows";
import { ShortenSeriesDialog } from "./ShortenSeriesDialog";

export function SeriesRequestPanel({ seriesId }: { seriesId: string }) {
  const navigate = useNavigate();
  const myRequestsQuery = useMyRequests();
  const withdrawMutation = useWithdrawRequestMutation();
  const cancelRideMutation = useCancelRideMutation();
  const [shortenOpen, setShortenOpen] = useState(false);
  const [confirmAction, setConfirmAction] = useState<ConfirmAction | null>(null);

  const row = toDisplayRows((myRequestsQuery.data ?? []).filter((candidate) => candidate.seriesId === seriesId)).find((candidate) => candidate.seriesLegs);
  const first = row?.departAt ?? row?.returnAt;
  const last = row?.returnAt ?? row?.departAt;
  const live = !!row && row.status !== "withdrawn" && row.status !== "cancelled";

  async function runConfirm() {
    if (!row || !confirmAction || confirmAction.kind === "withdrawFreedClaim" || confirmAction.kind === "withdrawAll") return;
    try {
      if (confirmAction.kind === "withdraw") {
        await withdrawMutation.mutateAsync({ requestId: row.id, expectedVersion: row.version });
      } else if (row.ride) {
        await cancelRideMutation.mutateAsync({ rideId: row.ride.id, reason: "CANCELLED_BY_MEMBER", expectedVersion: row.ride.version });
      }
      setConfirmAction(null);
      navigate(paths.my());
    } catch { /* the mutation shows its own localized error; keep the confirmation open */ }
  }

  return (
    <div className="space-y-4 p-4" data-testid="series-panel">
      {myRequestsQuery.isLoading ? (
        <div className="h-20 animate-pulse rounded-md bg-muted" />
      ) : (
        <>
          <div className="space-y-1 rounded-md border-s-4 border-primary bg-primary/5 p-3 text-sm">
            {first && last ? (
              <p className="font-semibold" data-testid="series-panel-title">
                {tv("request.seriesPanelTitle", { from: formatDayDate(first), to: formatDayDate(last) })}
              </p>
            ) : null}
            <p>{he.request.seriesPanelBody}</p>
          </div>
          {row ? <TripSummary destination={row.destination} purpose={row.rideTypeName} departAt={row.departAt} returnAt={row.returnAt} /> : null}
          <div className="flex flex-wrap gap-2">
            {row && live ? (
              <Button type="button" variant="outline" className="min-h-11" onClick={() => setShortenOpen(true)} data-testid="series-shorten">
                {he.request.shortenSeries}
              </Button>
            ) : null}
            {row && live && !row.ride ? (
              <Button type="button" variant="outline" className="min-h-11" onClick={() => setConfirmAction({ kind: "withdraw", row })} data-testid="series-withdraw">
                {he.requestsList.withdraw}
              </Button>
            ) : null}
            {row && live && row.ride && row.ride.status !== "cancelled" ? (
              <Button type="button" variant="outline" className="min-h-11" onClick={() => setConfirmAction({ kind: "cancel", row })} data-testid="series-cancel">
                {he.requestsList.cancelRide}
              </Button>
            ) : null}
            <Button asChild variant="ghost" className="min-h-11">
              <Link to={paths.my()}>{he.requestsList.title}</Link>
            </Button>
          </div>
        </>
      )}
      <ShortenSeriesDialog
        row={shortenOpen ? (row ?? null) : null}
        onOpenChange={(open) => {
          if (!open) setShortenOpen(false);
        }}
      />
      <ConfirmDialog
        open={!!confirmAction}
        onOpenChange={(open) => !open && setConfirmAction(null)}
        title={confirmDialogTitle(confirmAction)}
        description={confirmDialogDescription(confirmAction)}
        confirmLabel={confirmDialogLabel(confirmAction)}
        destructive
        loading={withdrawMutation.isPending || cancelRideMutation.isPending}
        onConfirm={() => void runConfirm()}
      />
    </div>
  );
}
