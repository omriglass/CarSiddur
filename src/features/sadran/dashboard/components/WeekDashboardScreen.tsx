import { AlertTriangle, CalendarDays } from "lucide-react";
import { useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { toast } from "sonner";

import { formatWeekRangeLabel } from "@/components/DateField";
import { EmptyState } from "@/components/EmptyState";
import { ErrorState } from "@/components/ErrorState";
import { PageHeader } from "@/components/PageHeader";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { fetchRideTypes } from "@/features/fleet/api";
import { useDepartments } from "@/features/siddur/hooks";
import { he, tv } from "@/i18n/he";
import { toAppError } from "@/lib/rpc";
import { useQuery } from "@tanstack/react-query";

import { scanBoardConflicts } from "../../board/geometry";
import { buildWeek } from "@/features/solverBridge/buildSolverInput";
import { deriveNeedsAttention, type NeedsAttentionKind } from "../needsAttention";
import {
  useActivePolicy,
  useAllWeekRides,
  useApplySolverResultMutation,
  useDepartmentSettings,
  useFreedOffersForWeek,
  useLatestSolverRun,
  useMaintenanceBlocks,
  useOpenWeekMutation,
  useProposalsForWeek,
  useRecordSolverPreviewMutation,
  useSetWeekPhaseMutation,
  useWeekRequests,
  useWeekRow,
} from "../../hooks";
import { buildApplyPayload, gatherSolverContext, hashSolverInput, nowMs, runSolve } from "../../solverRun";

import type { Json } from "@/integrations/supabase/types";
import type { SolverOutput } from "@/solver";

const NEEDS_ATTENTION_LABEL: Record<NeedsAttentionKind, (count: number) => string> = {
  lateRequests: (count) => tv("needsAttention.lateRequests", { count: String(count) }),
  changedRequests: (count) => tv("needsAttention.changedRequests", { count: String(count) }),
  expiringProposals: (count) => tv("needsAttention.expiringProposals", { count: String(count) }),
  chauffeurNeeded: (count) => tv("needsAttention.chauffeurNeeded", { count: String(count) }),
  carsAwayAtDayEnd: (count) => tv("needsAttention.carsAwayAtDayEnd", { count: String(count) }),
  maintenanceAffecting: (count) => tv("needsAttention.maintenanceAffecting", { count: String(count) }),
  contestedClaims: (count) => tv("needsAttention.contestedClaims", { count: String(count) }),
};

interface WeekDashboardScreenProps {
  departmentId: string;
  weekStart: string;
}

/** `/sadran/:dept/:week` — week dashboard (UX_FLOWS.md §4.1). */
export function WeekDashboardScreen({ departmentId, weekStart }: WeekDashboardScreenProps) {
  const navigate = useNavigate();

  const departmentsQuery = useDepartments();
  const department = (departmentsQuery.data ?? []).find((d) => d.id === departmentId);

  const weekRowQuery = useWeekRow(departmentId, weekStart);
  const requestsQuery = useWeekRequests(departmentId, weekStart);
  const ridesQuery = useAllWeekRides(departmentId, weekStart);
  const proposalsQuery = useProposalsForWeek(departmentId, weekStart);
  const freedOffersQuery = useFreedOffersForWeek(departmentId, weekStart);
  const maintenanceQuery = useMaintenanceBlocks(departmentId);
  const departmentSettingsQuery = useDepartmentSettings(departmentId);
  const activePolicyQuery = useActivePolicy(departmentId);
  const latestRunQuery = useLatestSolverRun(departmentId, weekStart);
  const rideTypesQuery = useQuery({ queryKey: ["sadran", "rideTypes"], queryFn: fetchRideTypes, staleTime: 5 * 60_000 });

  const openWeekMutation = useOpenWeekMutation();
  const setWeekPhaseMutation = useSetWeekPhaseMutation();
  const recordPreviewMutation = useRecordSolverPreviewMutation();
  const applyMutation = useApplySolverResultMutation();

  const [solving, setSolving] = useState(false);
  const [result, setResult] = useState<{ output: SolverOutput; payload: ReturnType<typeof buildApplyPayload> } | null>(
    null,
  );
  // Read once via a lazy initializer (not on every render, matching
  // `MaintenanceScreen`'s convention) rather than `Date.now()` directly during render.
  const [nowMsSnapshot] = useState(() => Date.now());

  const requests = requestsQuery.data ?? [];
  const nonDraft = requests.filter((r) => r.status !== "draft" && r.status !== "withdrawn");
  const served = nonDraft.filter((r) => r.status === "assigned" || r.status === "merged").length;
  const unmet = nonDraft.filter((r) => r.status === "waitlisted" || r.status === "denied").length;
  const awaitingAnswer = (proposalsQuery.data ?? []).filter((p) => p.status === "sent").length;
  const lateIds = nonDraft.filter((r) => r.is_late).map((r) => r.id);
  const changedIds = nonDraft.filter((r) => r.changed_since_solve).map((r) => r.id);

  const byType: { served: number; total: number; name: string }[] = [];
  {
    const groups = new Map<string, { served: number; total: number; name: string }>();
    const rideTypesById = new Map((rideTypesQuery.data ?? []).map((rt) => [rt.id, rt]));
    for (const r of nonDraft) {
      const rt = rideTypesById.get(r.ride_type_id);
      const key = rt?.code ?? "other";
      const entry = groups.get(key) ?? { served: 0, total: 0, name: rt?.name_he ?? key };
      entry.total += 1;
      if (r.status === "assigned" || r.status === "merged") entry.served += 1;
      groups.set(key, entry);
    }
    byType.push(...groups.values());
  }

  const expiringSoonMs = nowMsSnapshot + 6 * 3600_000;
  const expiringProposalIds = (proposalsQuery.data ?? [])
    .filter((p) => p.status === "sent" && Date.parse(p.expires_at) < expiringSoonMs)
    .map((p) => p.id);
  const contestedOfferIds = (freedOffersQuery.data ?? []).filter((o) => o.status === "pending_approval").map((o) => o.id);
  const chauffeurNeededCount = (latestRunQuery.data?.summary as { needsDriver?: number } | null)?.needsDriver ?? 0;

  const daySettings = departmentSettingsQuery.data;
  const conflictScan = useMemo(() => {
    if (!daySettings || !ridesQuery.data || !department?.home_destination_id) return null;
    const { startMs, days } = buildWeek(weekStart, daySettings.day_end_time);
    const rides = ridesQuery.data.filter(
      (r): r is typeof r & { id: string; car_id: string; starts_at: string; ends_at: string; origin_id: string; destination_id: string } =>
        !!r.id && !!r.car_id && !!r.starts_at && !!r.ends_at && !!r.origin_id && !!r.destination_id,
    );
    return scanBoardConflicts({
      rides: rides.map((r) => ({
        id: r.id,
        carId: r.car_id,
        startsAt: r.starts_at,
        endsAt: r.ends_at,
        originId: r.origin_id,
        destinationId: r.destination_id,
        overnightAck: !!r.overnight_ack_by,
      })),
      carIds: [...new Set(rides.map((r) => r.car_id))],
      weekStartMs: startMs,
      bufferMinutes: daySettings.turnaround_minutes,
      homeLocationId: department.home_destination_id,
      days,
    });
  }, [daySettings, ridesQuery.data, department?.home_destination_id, weekStart]);

  const carsAwayAtDayEndIds = conflictScan
    ? [...conflictScan.dayEndViolationsByCarId.entries()].filter(([, v]) => v.length > 0).map(([carId]) => carId)
    : [];

  const maintenanceBlocks = maintenanceQuery.data ?? [];
  const maintenanceAffectedRideIds = (ridesQuery.data ?? [])
    .filter((r) => r.car_id && r.starts_at && r.ends_at)
    .filter((r) =>
      maintenanceBlocks.some(
        (b) =>
          b.car_id === r.car_id &&
          Date.parse(b.starts_at) < Date.parse(r.ends_at as string) &&
          Date.parse(r.starts_at as string) < Date.parse(b.ends_at),
      ),
    )
    .map((r) => r.id as string);

  const needsAttention = deriveNeedsAttention({
    lateRequestIds: lateIds,
    changedRequestIds: changedIds,
    expiringProposalIds,
    chauffeurNeededRequestIds: Array.from({ length: chauffeurNeededCount }, (_, i) => `chauffeur-${i}`),
    carsAwayAtDayEndIds,
    maintenanceAffectedRideIds,
    contestedOfferIds,
  });

  const phase = weekRowQuery.data?.phase;

  async function handleRunSolver() {
    if (!activePolicyQuery.data || !department?.home_destination_id) {
      toast.error(he.errors.noHomeLocation);
      return;
    }
    setSolving(true);
    try {
      const context = await gatherSolverContext({
        departmentId,
        weekStart,
        homeDestinationId: department.home_destination_id,
        policy: {
          policyId: activePolicyQuery.data.policyId,
          policyVersionId: activePolicyQuery.data.policyVersionId,
          versionNo: activePolicyQuery.data.versionNo,
          rules: activePolicyQuery.data.rules,
        },
        mode: "full",
      });
      const startedAtMs = nowMs();
      const output = runSolve(context.input);
      const finishedAtMs = nowMs();
      const inputHash = hashSolverInput(context.input);
      const payload = buildApplyPayload({
        output,
        weekStartMs: context.weekStartMs,
        policyVersionId: context.policyVersionId,
        startedAtMs,
        finishedAtMs,
        inputHash,
        requestsById: context.requestsById,
      });
      await recordPreviewMutation.mutateAsync({
        departmentId,
        weekStart,
        payload: payload as unknown as Json,
      });
      setResult({ output, payload });
    } catch (error) {
      toast.error(toAppError(error).message);
    } finally {
      setSolving(false);
    }
  }

  async function handleApplyDraft() {
    if (!result) return;
    try {
      await applyMutation.mutateAsync({
        departmentId,
        weekStart,
        payload: result.payload as unknown as Json,
      });
      toast.success(he.sadranDashboard.applied);
      setResult(null);
      navigate(`/sadran/${departmentId}/${weekStart}/board`);
    } catch {
      // toast already shown by the mutation's onError
    }
  }

  if (weekRowQuery.isError || requestsQuery.isError) {
    return <ErrorState onRetry={() => weekRowQuery.refetch()} />;
  }

  return (
    <div className="mx-auto max-w-4xl space-y-4 p-4 pb-24">
      <PageHeader
        title={he.screen.sadran.dashboard}
        subtitle={`${department?.name ?? ""} · ${formatWeekRangeLabel(weekStart)}`}
      />

      <div className="flex flex-wrap items-center gap-2">
        {(["open", "solving", "published", "live", "archived"] as const).map((p) => (
          <Badge key={p} variant={phase === p ? "default" : "outline"}>
            {he.phase[p]}
          </Badge>
        ))}
        {!weekRowQuery.data ? (
          <Button
            size="sm"
            variant="outline"
            onClick={() => openWeekMutation.mutate({ departmentId, weekStart })}
            disabled={openWeekMutation.isPending}
          >
            {he.sadranDashboard.phaseOverrideOpen}
          </Button>
        ) : phase === "open" ? (
          <Button
            size="sm"
            variant="outline"
            onClick={() => setWeekPhaseMutation.mutate({ departmentId, weekStart, phase: "solving" })}
            disabled={setWeekPhaseMutation.isPending}
          >
            {he.action.closeWindow}
          </Button>
        ) : null}
      </div>

      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 md:grid-cols-6">
        {[
          { label: he.sadranDashboard.counters.requests, value: nonDraft.length },
          { label: he.sadranDashboard.counters.served, value: served },
          { label: he.sadranDashboard.counters.unmet, value: unmet },
          { label: he.sadranDashboard.counters.awaitingAnswer, value: awaitingAnswer },
          { label: he.sadranDashboard.counters.late, value: lateIds.length },
          { label: he.sadranDashboard.counters.changed, value: changedIds.length },
        ].map((c) => (
          <Card key={c.label}>
            <CardContent className="p-3 text-center">
              <div className="text-2xl font-semibold tabular-nums">{c.value}</div>
              <div className="text-xs text-muted-foreground">{c.label}</div>
            </CardContent>
          </Card>
        ))}
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <Button onClick={handleRunSolver} disabled={solving || !activePolicyQuery.data}>
          {solving ? he.sadranDashboard.solving : he.action.runSolver}
        </Button>
        <Button variant="outline" onClick={() => navigate(`/sadran/${departmentId}/${weekStart}/board`)}>
          {he.action.openBoard}
        </Button>
        <Button variant="outline" onClick={() => navigate(`/sadran/${departmentId}/${weekStart}/proposals`)}>
          {tv("sadranDashboard.proposalsButton", { count: String(proposalsQuery.data?.length ?? 0) })}
        </Button>
        <Button variant="outline" onClick={() => navigate(`/sadran/${departmentId}/${weekStart}/publish`)}>
          {he.action.publish}
        </Button>
      </div>

      <Card>
        <CardContent className="space-y-2 p-4 text-sm">
          <h2 className="font-medium">{he.sadranDashboard.byTypeTitle}</h2>
          <div className="flex flex-wrap gap-x-4 gap-y-1 text-muted-foreground">
            {byType.length === 0 ? (
              <span>—</span>
            ) : (
              byType.map((t) => (
                <span key={t.name}>
                  {t.name} <span dir="ltr">{t.served}/{t.total}</span>
                </span>
              ))
            )}
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardContent className="space-y-2 p-4">
          <h2 className="font-medium">{he.sadranDashboard.needsAttentionTitle}</h2>
          {needsAttention.length === 0 ? (
            <EmptyState icon={CalendarDays} message={he.sadranDashboard.needsAttentionEmpty} />
          ) : (
            <ul className="space-y-1 text-sm">
              {needsAttention.map((section) => (
                <li key={section.kind} className="flex items-center justify-between gap-2">
                  <span className="flex items-center gap-2">
                    <AlertTriangle className="size-3.5 shrink-0 text-amber-600" aria-hidden="true" />
                    {NEEDS_ATTENTION_LABEL[section.kind](section.count)}
                  </span>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => navigate(`/sadran/${departmentId}/${weekStart}/board`)}
                  >
                    {he.sadranDashboard.show}
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      <Sheet open={!!result} onOpenChange={(open) => !open && setResult(null)}>
        <SheetContent side="bottom" className="max-h-[85dvh] overflow-y-auto">
          <SheetHeader>
            <SheetTitle>{he.sadranDashboard.resultSheetTitle}</SheetTitle>
          </SheetHeader>
          {result ? (
            <div className="space-y-4 py-4 text-sm">
              <p>
                {tv("sadranDashboard.resultSummary", {
                  served: String(result.output.stats.served),
                  total: String(result.output.stats.served + result.output.stats.unmet),
                  withSuggestions: String(result.output.unmet.filter((u) => u.suggestions.length > 0).length),
                  needsDriver: String(result.output.stats.needsDriver),
                })}
              </p>
              <Button className="w-full" size="lg" onClick={handleApplyDraft} disabled={applyMutation.isPending}>
                {he.sadranDashboard.applyDraft}
              </Button>
            </div>
          ) : null}
        </SheetContent>
      </Sheet>
    </div>
  );
}
