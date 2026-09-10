import { useState, type ReactNode } from "react";
import { formatInTimeZone } from "date-fns-tz";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { useRideTypes } from "@/features/fleet/hooks";
import { he, tv } from "@/i18n/he";
import { weekdayLabel } from "@/lib/dayLabels";
import { rideBlockLabel } from "@/lib/rideLabel";
import { showErrorToast } from "@/lib/rpc";
import { TZ, formatTime } from "@/lib/time";
import type { Json } from "@/integrations/supabase/types";
import type { ActivePolicy } from "../../api";
import { useApplySolverResultMutation, useWeekRow } from "../../hooks";
import {
  buildApplyPayload, computeFullResolveDiff, gatherSolverContext, hashSolverInput,
  nowMs, runSolve, servedOf, type FullResolveDiff,
} from "../../solverRun";

interface FullResolveActionProps {
  departmentId: string;
  weekStart: string;
  homeDestinationId: string | null;
  policy: ActivePolicy | null;
  onPolicyUsed?: (policyVersionId: string) => void;
  disabled?: boolean;
  /**
   * Custom trigger rendering (the board's kebab "actions" menu, UX_FLOWS.md
   * §4.2): defaults to the original inline `Button`, so every other caller
   * is unaffected. `onClick` still runs the same `prepare()` — the diff
   * `Sheet` below is unchanged either way.
   */
  renderTrigger?: (props: { onClick: () => void; disabled: boolean; loading: boolean }) => ReactNode;
}

/** Full solving replaces unpinned placements only after reviewing the concrete diff. */
export function FullResolveAction({ departmentId, weekStart, homeDestinationId, policy, onPolicyUsed, disabled, renderTrigger }: FullResolveActionProps) {
  const weekQuery = useWeekRow(departmentId, weekStart);
  const rideTypesQuery = useRideTypes(departmentId);
  const applyMutation = useApplySolverResultMutation();
  const [loading, setLoading] = useState(false);
  const [preview, setPreview] = useState<{ payload: ReturnType<typeof buildApplyPayload>; diff: FullResolveDiff } | null>(null);

  async function prepare() {
    if (!policy || !homeDestinationId) return;
    setLoading(true);
    try {
      const context = await gatherSolverContext({ departmentId, weekStart, homeDestinationId, policy, mode: "full" });
      const startedAtMs = nowMs();
      const output = runSolve(context.input);
      onPolicyUsed?.(policy.policyVersionId);
      const finishedAtMs = nowMs();
      const diff = computeFullResolveDiff(context, output);
      // Replace the legacy UUID/timestamp fallback with recognizable ride details.
      for (const item of diff.changedOrRemovedRides) {
        const ride = context.replaceableRides.find((ride) => ride.id === item.rideId);
        if (!ride?.origin_id || !ride.destination_id) continue;
        const label = rideBlockLabel({
          originId: ride.origin_id, destinationId: ride.destination_id,
          originName: ride.origin_name ?? "", destinationName: ride.destination_name ?? "",
          homeDestinationId, served: servedOf(ride), driverName: ride.driver_name,
          isChauffeur: !!ride.is_chauffeur, needsDriver: !!ride.needs_driver,
        });
        const car = context.input.cars.find((car) => car.id === item.carId)?.name ?? "";
        const weekday = weekdayLabel(item.startsAt);
        const purposes = [...new Set(servedOf(ride).map((entry) => rideTypesQuery.data?.find((type) => type.code === entry.ride_type)?.name_he).filter(Boolean))].join(" / ");
        item.label = `${label} · ${car} · ${weekday} ${formatInTimeZone(item.startsAt, TZ, "dd/MM HH:mm")}–${formatTime(new Date(item.endsAt))}${purposes ? ` · ${purposes}` : ""}`;
      }
      setPreview({ diff, payload: buildApplyPayload({ output, weekStartMs: context.weekStartMs,
        policyVersionId: context.policyVersionId, startedAtMs, finishedAtMs,
        inputHash: hashSolverInput(context.input), requestsById: context.requestsById, mode: "full" }) });
    } catch (error) {
      showErrorToast(error);
    } finally { setLoading(false); }
  }

  async function apply() {
    if (!preview) return;
    try {
      const summary = await applyMutation.mutateAsync({ departmentId, weekStart, payload: preview.payload as unknown as Json });
      toast.success(tv("sadranDashboard.appliedSummary", { inserted: String(summary.inserted), deleted: String(summary.deleted), unassigned: String(summary.unassigned_requests.length) }));
      if (summary.skippedSeries?.length) {
        toast(tv("sadranBoard.skippedSeries", { count: String(summary.skippedSeries.length) }));
      }
      setPreview(null);
    } catch { /* The mutation reports validation/staleness errors. */ }
  }

  const triggerDisabled = disabled || loading || applyMutation.isPending || !policy || !homeDestinationId || weekQuery.data?.phase === "archived";
  return <>
    {renderTrigger ? renderTrigger({ onClick: () => void prepare(), disabled: triggerDisabled, loading }) : (
      <Button variant="outline" size="sm" disabled={triggerDisabled} onClick={() => void prepare()}>
        {loading ? he.sadranDashboard.fullResolveLoading : he.sadranDashboard.fullResolveButton}
      </Button>
    )}
    <Sheet open={!!preview} onOpenChange={(open) => !open && !applyMutation.isPending && setPreview(null)}>
      <SheetContent side="bottom" className="max-h-[85dvh] overflow-y-auto">
        <SheetHeader><SheetTitle>{he.sadranDashboard.fullResolveConfirmTitle}</SheetTitle></SheetHeader>
        {preview ? <div className="space-y-4 py-4 text-sm">
          {preview.diff.changedOrRemovedRides.length ? <>
            <p className="rounded-md border border-maintenance/40 bg-maintenance/10 p-2 text-maintenance">{tv("sadranDashboard.fullResolveConfirmBody", {
              rideCount: String(preview.diff.changedOrRemovedRides.length), lostCount: String(preview.diff.requestsLosingAssignment),
            })}</p>
            <h3 className="font-medium">{he.sadranDashboard.fullResolveRidesListTitle}</h3>
            <ul className="max-h-48 space-y-1 overflow-y-auto text-muted-foreground">{preview.diff.changedOrRemovedRides.map((ride) => <li key={ride.rideId}>{ride.label}</li>)}</ul>
          </> : <p className="text-muted-foreground">{he.sadranDashboard.fullResolveConfirmNone}</p>}
          <Button className="w-full" size="lg" disabled={applyMutation.isPending} onClick={() => void apply()}>{he.sadranDashboard.fullResolveConfirmAction}</Button>
        </div> : null}
      </SheetContent>
    </Sheet>
  </>;
}
