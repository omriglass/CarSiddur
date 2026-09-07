import { AlertTriangle, CalendarDays } from "lucide-react";
import { useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { toast } from "sonner";

import { formatWeekRangeLabel } from "@/components/DateField";
import { EmptyState } from "@/components/EmptyState";
import { ErrorState } from "@/components/ErrorState";
import { PageHeader } from "@/components/PageHeader";
import { StatTilesSkeleton } from "@/components/skeletons/StatTilesSkeleton";
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
import { isUnmetStatus } from "../../unmetStatuses";
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
  useWeekRequestsWithNames,
  useWeekRow,
} from "../../hooks";
import {
  buildApplyPayload,
  computeFullResolveDiff,
  gatherSolverContext,
  hashSolverInput,
  nowMs,
  runSolve,
  type FullResolveDiff,
} from "../../solverRun";

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
  const requestsQuery = useWeekRequestsWithNames(departmentId, weekStart);
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
  const [confirmingReplace, setConfirmingReplace] = useState(false);
  // Read once via a lazy initializer (not on every render, matching
  // `MaintenanceScreen`'s convention) rather than `Date.now()` directly during render.
  const [nowMsSnapshot] = useState(() => Date.now());

  // "פתור מחדש את כל השבוע" (UX_FLOWS.md §19/§20 — a separate, explicit
  // secondary action next to the primary "הרץ פותר"): `mode: 'full'` may
  // replace non-pinned rides, so it always previews the diff first
  // (`computeFullResolveDiff`) and requires an explicit confirm before
  // applying — unlike the primary Solve action above, which applies its
  // 'remaining'-mode result directly since it can only ever add rides.
  const [fullResolvePreview, setFullResolvePreview] = useState<{
    payload: ReturnType<typeof buildApplyPayload>;
    diff: FullResolveDiff;
  } | null>(null);
  const [fullResolveLoading, setFullResolveLoading] = useState(false);

  const requests = requestsQuery.data ?? [];
  const nonDraft = requests.filter((r) => r.status !== "draft" && r.status !== "withdrawn");
  const served = nonDraft.filter((r) => r.status === "assigned" || r.status === "merged").length;
  // Owner bug report #1: "לא שובצו" must count every request without a ride
  // (submitted/proposed/waitlisted/denied), not only waitlisted/denied — a
  // freshly-submitted, never-solved week showed 0 here even with 40+ open
  // requests, matching the board's own `UnmetList` definition (`isUnmetStatus`).
  const unmet = nonDraft.filter((r) => isUnmetStatus(r.status)).length;
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

  /**
   * MAJOR BUG fix (docs/UX_FLOWS.md §19 "Solve/apply semantics after owner
   * testing"): the dashboard's "הרץ פותר" is the app's primary Solve
   * action, so — per the investigation's required outcome — it must never
   * remove or un-assign anything. It now always gathers/solves/applies in
   * `'remaining'` mode ("שבץ בקשות פתוחות" — every current ride, pinned or
   * not, is passed to the solver as a fixed constraint; `solve()` only ever
   * places requests that have no ride at all), the same safe semantics
   * `BoardScreen.tsx`'s "▶ השלם אוטומטית" already used. A full re-solve of
   * the whole week (replacing non-pinned solver-made rides,
   * `previousAssignments` for continuity, confirming exactly what would
   * change) is still implemented — `../../applySolve.ts`'s `mode: 'full'`
   * path plus `computeFullResolveDiff` — but is not wired to a button here;
   * see this file's header note in the investigation report for why (the
   * board layout is being redesigned concurrently and adding a new confirm
   * surface is out of scope for a handler-body-only change).
   */
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
        mode: "remaining",
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
        mode: "remaining",
      });
      await recordPreviewMutation.mutateAsync({
        departmentId,
        weekStart,
        payload: payload as unknown as Json,
      });
      setResult({ output, payload });
      setConfirmingReplace(false);
    } catch (error) {
      toast.error(toAppError(error).message);
    } finally {
      setSolving(false);
    }
  }

  /**
   * Dead in practice now that `handleRunSolver` always builds a
   * `mode: 'remaining'` payload (which `apply_solver_result` never lets
   * delete anything, migration 20260907093100) — kept keyed off
   * `result.payload.mode` rather than deleted outright so a future `'full'`
   * re-solve entry point (see the note above) only needs to set that mode
   * to make this guard live again, and so the existing confirm-dialog JSX
   * (`confirmingReplace`, `replaceUnpinnedConfirmBody`) keeps working
   * unchanged.
   */
  const existingUnpinnedRideCount = (ridesQuery.data ?? []).filter((r) => r.status === "draft" && !r.is_pinned).length;

  async function handleApplyDraft() {
    if (!result) return;
    if (result.payload.mode === "full" && existingUnpinnedRideCount > 0 && !confirmingReplace) {
      setConfirmingReplace(true);
      return;
    }
    try {
      const summary = await applyMutation.mutateAsync({
        departmentId,
        weekStart,
        payload: result.payload as unknown as Json,
      });
      // Structured summary (bug-fix pass requirement: never a silent
      // partial result) — `apply_solver_result` returns exactly what it did.
      toast.success(
        tv("sadranDashboard.appliedSummary", {
          inserted: String(summary.inserted),
          deleted: String(summary.deleted),
          unassigned: String(summary.unassigned_requests.length),
        }),
      );
      setResult(null);
      setConfirmingReplace(false);
      navigate(`/sadran/${departmentId}/${weekStart}/board`);
    } catch {
      // toast already shown by the mutation's onError
    }
  }

  /**
   * Gathers/solves in `mode: 'full'` and computes the confirm dialog's diff
   * (`computeFullResolveDiff`) — never applies anything itself; nothing is
   * written to the DB until `handleApplyFullResolve` below.
   */
  async function handleRunFullResolve() {
    if (!activePolicyQuery.data || !department?.home_destination_id) {
      toast.error(he.errors.noHomeLocation);
      return;
    }
    setFullResolveLoading(true);
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
      const diff = computeFullResolveDiff(context, output);
      const payload = buildApplyPayload({
        output,
        weekStartMs: context.weekStartMs,
        policyVersionId: context.policyVersionId,
        startedAtMs,
        finishedAtMs,
        inputHash: hashSolverInput(context.input),
        requestsById: context.requestsById,
        mode: "full",
      });
      setFullResolvePreview({ payload, diff });
    } catch (error) {
      toast.error(toAppError(error).message);
    } finally {
      setFullResolveLoading(false);
    }
  }

  async function handleApplyFullResolve() {
    if (!fullResolvePreview) return;
    try {
      const summary = await applyMutation.mutateAsync({
        departmentId,
        weekStart,
        payload: fullResolvePreview.payload as unknown as Json,
      });
      toast.success(
        tv("sadranDashboard.appliedSummary", {
          inserted: String(summary.inserted),
          deleted: String(summary.deleted),
          unassigned: String(summary.unassigned_requests.length),
        }),
      );
      setFullResolvePreview(null);
      navigate(`/sadran/${departmentId}/${weekStart}/board`);
    } catch {
      // toast already shown by the mutation's onError
    }
  }

  if (weekRowQuery.isError || requestsQuery.isError) {
    return <ErrorState onRetry={() => weekRowQuery.refetch()} />;
  }

  // Papercut fix (usability sweep, same as BoardScreen.tsx): otherwise the
  // counters row renders as all-zero for a moment on every load, before the
  // real counts arrive — indistinguishable from an actually-empty week.
  if (requestsQuery.isLoading) {
    return (
      <div className="mx-auto max-w-4xl space-y-4 p-4 pb-24">
        <PageHeader
          title={he.screen.sadran.dashboard}
          subtitle={`${department?.name ?? ""} · ${formatWeekRangeLabel(weekStart)}`}
        />
        <StatTilesSkeleton />
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-4xl space-y-4 p-4 pb-24">
      <PageHeader
        title={he.screen.sadran.dashboard}
        subtitle={`${department?.name ?? ""} · ${formatWeekRangeLabel(weekStart)}`}
      />

      <div className="flex flex-wrap items-center gap-2">
        {(["open", "solving", "published", "live", "archived"] as const).map((p) => (
          <span
            key={p}
            className={
              phase === p
                ? "rounded-full bg-primary px-3 py-1 text-xs font-semibold text-primary-foreground shadow-sm"
                : "rounded-full border border-border px-3 py-1 text-xs text-muted-foreground"
            }
          >
            {he.phase[p]}
          </span>
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
          { label: he.sadranDashboard.counters.requests, value: nonDraft.length, border: "border-t-primary" },
          { label: he.sadranDashboard.counters.served, value: served, border: "border-t-available" },
          { label: he.sadranDashboard.counters.unmet, value: unmet, border: "border-t-destructive" },
          { label: he.sadranDashboard.counters.awaitingAnswer, value: awaitingAnswer, border: "border-t-maintenance" },
          { label: he.sadranDashboard.counters.late, value: lateIds.length, border: "border-t-maintenance" },
          { label: he.sadranDashboard.counters.changed, value: changedIds.length, border: "border-t-booked" },
        ].map((c) => (
          <Card key={c.label} className={`border-t-4 bg-gradient-card shadow-card ${c.border}`}>
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
        <Button
          variant="outline"
          onClick={() => void handleRunFullResolve()}
          disabled={fullResolveLoading || !activePolicyQuery.data}
        >
          {fullResolveLoading ? he.sadranDashboard.fullResolveLoading : he.sadranDashboard.fullResolveButton}
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

      <Card className="bg-gradient-card shadow-card">
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

      <Card className="bg-gradient-card shadow-card">
        <CardContent className="space-y-2 p-4">
          <h2 className="font-medium">{he.sadranDashboard.needsAttentionTitle}</h2>
          {needsAttention.length === 0 ? (
            <EmptyState icon={CalendarDays} message={he.sadranDashboard.needsAttentionEmpty} />
          ) : (
            <ul className="space-y-1 text-sm">
              {needsAttention.map((section) => (
                <li key={section.kind} className="flex items-center justify-between gap-2 rounded-md px-1 py-1">
                  <span className="flex items-center gap-2">
                    <span className="size-2 shrink-0 rounded-full bg-maintenance" aria-hidden="true" />
                    <AlertTriangle className="size-3.5 shrink-0 text-maintenance" aria-hidden="true" />
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

      <Sheet
        open={!!result}
        onOpenChange={(open) => {
          if (!open) {
            setResult(null);
            setConfirmingReplace(false);
          }
        }}
      >
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
              <p className="text-muted-foreground">
                {tv("sadranDashboard.resultBreakdown", {
                  assigned: String(result.output.assignments.flatMap((a) => a.legs).filter((l) => l.role === "driver").length),
                  merged: String(result.output.assignments.flatMap((a) => a.legs).filter((l) => l.role === "passenger").length),
                })}
              </p>

              {result.output.unmet.length > 0 ? (
                <div className="space-y-1">
                  <h3 className="font-medium">
                    {tv("sadranDashboard.resultUnmetTitle", { count: String(result.output.unmet.length) })}
                  </h3>
                  <ul className="max-h-40 space-y-1 overflow-y-auto text-xs text-muted-foreground">
                    {result.output.unmet.map((u) => {
                      const req = requests.find((r) => r.id === u.requestId);
                      return (
                        <li key={u.requestId} className="flex justify-between gap-2">
                          <span>{req?.requester_full_name ?? u.requestId}</span>
                          <span>{u.reason}</span>
                        </li>
                      );
                    })}
                  </ul>
                </div>
              ) : null}

              {confirmingReplace ? (
                <p className="rounded-md border border-maintenance/40 bg-maintenance/10 p-2 text-maintenance">
                  {tv("sadranDashboard.replaceUnpinnedConfirmBody", { count: String(existingUnpinnedRideCount) })}
                </p>
              ) : null}

              <Button className="w-full" size="lg" onClick={handleApplyDraft} disabled={applyMutation.isPending}>
                {confirmingReplace ? he.sadranDashboard.replaceUnpinnedConfirmAction : he.sadranDashboard.applyDraft}
              </Button>
            </div>
          ) : null}
        </SheetContent>
      </Sheet>

      <Sheet open={!!fullResolvePreview} onOpenChange={(open) => !open && setFullResolvePreview(null)}>
        <SheetContent side="bottom" className="max-h-[85dvh] overflow-y-auto">
          <SheetHeader>
            <SheetTitle>{he.sadranDashboard.fullResolveConfirmTitle}</SheetTitle>
          </SheetHeader>
          {fullResolvePreview ? (
            <div className="space-y-4 py-4 text-sm">
              {fullResolvePreview.diff.changedOrRemovedRides.length === 0 ? (
                <p className="text-muted-foreground">{he.sadranDashboard.fullResolveConfirmNone}</p>
              ) : (
                <>
                  <p className="rounded-md border border-maintenance/40 bg-maintenance/10 p-2 text-maintenance">
                    {tv("sadranDashboard.fullResolveConfirmBody", {
                      rideCount: String(fullResolvePreview.diff.changedOrRemovedRides.length),
                      lostCount: String(fullResolvePreview.diff.requestsLosingAssignment),
                    })}
                  </p>
                  <div className="space-y-1">
                    <h3 className="font-medium">{he.sadranDashboard.fullResolveRidesListTitle}</h3>
                    <ul className="max-h-40 space-y-1 overflow-y-auto text-xs text-muted-foreground">
                      {fullResolvePreview.diff.changedOrRemovedRides.map((r) => (
                        <li key={r.rideId} dir="ltr" className="text-end">
                          {r.label}
                        </li>
                      ))}
                    </ul>
                  </div>
                </>
              )}

              <Button className="w-full" size="lg" onClick={() => void handleApplyFullResolve()} disabled={applyMutation.isPending}>
                {he.sadranDashboard.fullResolveConfirmAction}
              </Button>
            </div>
          ) : null}
        </SheetContent>
      </Sheet>
    </div>
  );
}
