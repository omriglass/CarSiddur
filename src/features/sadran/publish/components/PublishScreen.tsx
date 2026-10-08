import { useNavigate } from "react-router-dom";
import { toast } from "sonner";

import { paths } from "@/app/routes";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { formatWeekRangeLabel } from "@/components/dateFieldDates";
import { TripSummary } from "@/components/TripSummary";
import { PageHeader } from "@/components/PageHeader";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { ErrorState } from "@/components/ErrorState";
import { useState } from "react";
import { he, t, tv, type TranslationKey } from "@/i18n/he";
import { formatDayDate } from "@/lib/dayLabels";
import { dateKey, formatTime } from "@/lib/time";
import { alternativePlanText } from "@/features/sadran/board/planBLine";
import { requestStart } from "@/features/sadran/board/phantomLanes";
import type { PublicationDay } from "../../api";

import { computeDiffSummary } from "../diffSummary";
import { placedTimes } from "../placedTimes";
import {
  useAllWeekRides,
  usePublicationReadiness,
  usePublishSiddurMutation,
  useProposalsForWeek,
  useSiddurVersions,
  useWeekRequestsWithNames,
} from "../../hooks";
import type { PolicyBoardScore } from "../profileScores";
import { RideChangeAnswers } from "@/features/siddur/components/RideChangeAnswers";

interface PublishScreenProps {
  departmentId: string;
  weekStart: string;
}

/** `/sadran/:dept/:week/publish` — publish confirmation (UX_FLOWS.md §4.5). */
export function PublishScreen({ departmentId, weekStart }: PublishScreenProps) {
  const navigate = useNavigate();
  const [selectedDays, setSelectedDays] = useState<string[] | null>(null);
  const [confirmDays, setConfirmDays] = useState<string[] | null>(null);
  const readinessQuery = usePublicationReadiness(departmentId, weekStart);

  const requestsQuery = useWeekRequestsWithNames(departmentId, weekStart);
  const ridesQuery = useAllWeekRides(departmentId, weekStart);
  const versionsQuery = useSiddurVersions(departmentId, weekStart);
  const proposalsQuery = useProposalsForWeek(departmentId, weekStart);
  const publishMutation = usePublishSiddurMutation();

  const versions = versionsQuery.data ?? [];
  const previousVersion = versions[0] ?? null;
  const savedScores = ((previousVersion?.snapshot as { policy_scores?: PolicyBoardScore[] } | null)?.policy_scores ?? []);

  const readiness = readinessQuery.data ?? [];
  // REQ §13.94: unsent drafts block their day; list them (who/what/which day) with a way back.
  const draftRows = (proposalsQuery.data ?? []).filter((proposal) => proposal.status === "draft").flatMap((proposal) => {
    const request = (requestsQuery.data ?? []).find((r) => r.id === proposal.request_id);
    const anchor = request ? requestStart(request) : null;
    return anchor ? [{ id: proposal.id, name: request?.requester_full_name ?? "", type: proposal.type, day: dateKey(anchor) }] : [];
  });
  const draftDays = new Set(readiness.filter((day) => day.draftProposals > 0).map((day) => day.day));
  // REQ §13.112 (a): a SENT plan-B proposal that nobody answered yet holds its day back (server: publication_alternatives_pending,
  // never bypassable). An unsent plan-B draft is listed once, with the other drafts above (R10B3).
  const alternativeRows = (proposalsQuery.data ?? []).filter((proposal) => proposal.type === "alternative" && ["sent", "accepted"].includes(proposal.status)).flatMap((proposal) => {
    const request = (requestsQuery.data ?? []).find((r) => r.id === proposal.request_id);
    const anchor = request ? requestStart(request) : null;
    return request && anchor ? [{ id: proposal.id, name: request.requester_full_name ?? "", day: dateKey(anchor), plan: request.alternative ? alternativePlanText(request.alternative) : "" }] : [];
  });
  const blocksDay = (day: PublicationDay) => day.conflictRides > 0 || day.draftProposals > 0 || (day.alternativeProposals ?? 0) > 0;
  const allDays = readiness.map((day) => day.day);
  const readyDays = readiness.filter((day) => day.ready).map((day) => day.day);
  // R7U2: the "choose days" list pre-ticks only days that are ready, not yet published and not past.
  const todayKey = dateKey(new Date());
  const preselectedDays = readiness.filter((day) => day.ready && !day.published && day.day >= todayKey).map((day) => day.day);
  const chosenDays = selectedDays ?? allDays;
  const chosen = readiness.filter((day) => chosenDays.includes(day.day));
  const conflictCount = chosen.reduce((count, day) => count + day.conflictRides, 0);
  const rides = (ridesQuery.data ?? []).filter((ride) => ride.starts_at && chosenDays.includes(dateKey(ride.starts_at)));
  const chosenRequests = (requestsQuery.data ?? []).filter((request) => {
    const anchor = request.trip_shape === "one_way_from" ? request.return_at : request.depart_at;
    return anchor && chosenDays.includes(dateKey(anchor));
  });
  // R4U4: sent deny/external proposals on the published days expire at publication - list them in the confirmation.
  const expiringProposals = (proposalsQuery.data ?? []).filter((proposal) => (proposal.type === "deny" || proposal.type === "external") && proposal.status === "sent")
    .flatMap((proposal) => {
      const request = (requestsQuery.data ?? []).find((r) => r.id === proposal.request_id);
      const anchor = request ? requestStart(request) : null;
      return request && anchor && (confirmDays ?? []).includes(dateKey(anchor))
        ? [{ id: proposal.id, name: request.requester_full_name ?? "", type: proposal.type, day: dateKey(anchor) }] : [];
    });
  // R5U3: sent proposals other than deny/external (those expire at publication, listed above) stay pending; show who and until when.
  const pendingProposalRows = (proposalsQuery.data ?? []).filter((proposal) => proposal.type !== "deny" && proposal.type !== "external" && proposal.status === "sent")
    .flatMap((proposal) => {
      const request = (requestsQuery.data ?? []).find((r) => r.id === proposal.request_id);
      const anchor = request ? requestStart(request) : null;
      return request && anchor && (confirmDays ?? []).includes(dateKey(anchor))
        ? [{ id: proposal.id, name: request.requester_full_name ?? "", type: proposal.type, day: dateKey(anchor), expires: proposal.expires_at }] : [];
    });
  const countLabel = (count: number, many: "unresolved" | "pending" | "missingDriver") =>
    count === 1 ? t(`publicationFlow.${many}One` as TranslationKey) : tv(`publicationFlow.${many}` as TranslationKey, { count: String(count) });
  const previewQueries = [requestsQuery, ridesQuery, versionsQuery];
  const unavailable = readinessQuery.isLoading || readinessQuery.isError || !readiness.length || publishMutation.isPending || previewQueries.some((query) => query.isLoading || query.isError);
  const dateLabel = (day: string) => formatDayDate(`${day}T12:00:00Z`);

  const previousSnapshot = previousVersion?.snapshot as
    | { published_days?: string[]; rides?: { id: string; starts_at: string; ends_at: string; car_id: string; status: string }[]; requests?: { id: string; status: string; status_reason: string | null }[] }
    | undefined;

  const diff = computeDiffSummary({
    previousRides: previousSnapshot?.rides?.filter((ride) => chosenDays.includes(dateKey(ride.starts_at)) && (previousSnapshot.published_days?.includes(dateKey(ride.starts_at))) !== false) ?? null,
    currentRides: rides
      .filter((r) => r.id && r.starts_at && r.ends_at && r.car_id)
      .map((r) => ({ id: r.id as string, starts_at: r.starts_at as string, ends_at: r.ends_at as string, car_id: r.car_id as string, status: r.status ?? "draft" })),
    previousRequests: previousSnapshot?.requests?.filter((request) => chosenRequests.some((current) => current.id === request.id)) ?? null,
    currentRequests: chosenRequests
      .filter((r) => r.status !== "draft" && r.status !== "withdrawn")
      .map((r) => ({ id: r.id, status: r.status, status_reason: r.status_reason })),
  });

  const notifyList = chosenRequests.filter((r) => r.status !== "draft" && r.status !== "withdrawn");

  function proposePublish(days: string[]) {
    if (!days.length) return;
    const chosen = readiness.filter((day) => days.includes(day.day));
    if (chosen.some(blocksDay)) return;
    // `unresolvedRequests` no longer blocks publication (REQ §13.75) — an unresolved request is
    // auto-approved or grouped at publication time, `incompleteAssignments` is the real defect.
    if (chosen.some((day) => day.incompleteAssignments > 0 || day.pendingProposals > 0 || day.missingDriverRides > 0)) {
      setConfirmDays(days);
    } else void handlePublish(days, false);
  }

  async function handlePublish(days: string[], allowUnanswered: boolean) {
    try {
      await publishMutation.mutateAsync({ departmentId, weekStart, days, allowUnanswered });
      const labelled = days.map((day) => formatDayDate(`${day}T12:00:00Z`)).join(", ");
      toast.success(tv("sadranPublish.successDays", { days: labelled }));
      navigate(paths.sadran.board(departmentId, weekStart));
    } catch {
      // toast already shown
    }
  }

  return (
    <div className="mx-auto max-w-3xl space-y-4 p-4 pb-24">
      <PageHeader title={he.screen.publish.title} subtitle={formatWeekRangeLabel(weekStart)} actions={<Button variant="ghost" onClick={() => navigate(paths.sadran.board(departmentId, weekStart))}>{he.publicationFlow.backToBoard}</Button>} />
      {readinessQuery.isError ? <ErrorState onRetry={() => void readinessQuery.refetch()} /> : null}
      {previewQueries.some((query) => query.isError) ? <ErrorState onRetry={() => void Promise.all(previewQueries.map((query) => query.refetch()))} /> : null}
      <Card><CardContent className="space-y-3 p-4">
        <h2 className="font-semibold">{he.publicationFlow.allQuestion}</h2>
        <p className="text-sm text-muted-foreground" data-testid="publish-placed-count">{tv("publicationFlow.placedCount", {
          total: String(readiness.reduce((n, day) => n + day.requestCount - (day.answeredRequests ?? 0), 0)),
          placed: String(readiness.reduce((n, day) => n + day.requestCount - (day.answeredRequests ?? 0) - day.unresolvedRequests, 0)),
        })}</p>
        {readiness.reduce((n, day) => n + (day.answeredRequests ?? 0), 0) > 0 ? (
          <p className="text-sm text-muted-foreground" data-testid="publish-answered-count">{(() => {
            const answered = readiness.reduce((n, day) => n + (day.answeredRequests ?? 0), 0);
            return answered === 1 ? he.publicationFlow.answeredElsewhereOne : tv("publicationFlow.answeredElsewhere", { count: String(answered) });
          })()}</p>
        ) : null}
        <p className="text-sm text-muted-foreground">{readyDays.length === 7 ? he.publicationFlow.allReady : tv("publicationFlow.readiness", { count: String(readyDays.length) })}</p>
        <div className="flex flex-wrap gap-2">
          <Button disabled={unavailable || readiness.some(blocksDay)} onClick={() => proposePublish(allDays)}>{publishMutation.isPending ? he.publishScores.calculating : he.publicationFlow.allYes}</Button>
          <Button variant="outline" disabled={unavailable} onClick={() => setSelectedDays(preselectedDays)}>{he.publicationFlow.onlyReady}</Button>
          <Button variant="ghost" disabled={unavailable} onClick={() => setSelectedDays(preselectedDays)}>{he.publicationFlow.selectDays}</Button>
        </div>
        {selectedDays ? <div className="space-y-2 border-t pt-3">
          <p className="text-sm text-muted-foreground">{he.publicationFlow.partialHint}</p>
          {readiness.map((day) => <label key={day.day} className="flex items-start gap-3 rounded-md border p-3 text-sm">
            <Checkbox checked={selectedDays.includes(day.day)} disabled={blocksDay(day) || publishMutation.isPending} onCheckedChange={(checked) => setSelectedDays((current) => checked ? [...(current ?? []), day.day] : (current ?? []).filter((value) => value !== day.day))} />
            <span className="space-y-1">
              <span className="block font-medium">{dateLabel(day.day)}{day.published ? ` · ${he.publicationFlow.published}` : ""}</span>
              <span className="block text-xs text-muted-foreground">{day.ready ? he.publicationFlow.ready : [
                day.unresolvedRequests ? countLabel(day.unresolvedRequests, "unresolved") : null,
                day.draftProposals ? tv("boardDrafts.publishDayDrafts", { count: String(day.draftProposals) }) : null,
                day.alternativeProposals ? (day.alternativeProposals === 1 ? he.sadranPlanB.publishDayOne : tv("sadranPlanB.publishDay", { count: String(day.alternativeProposals) })) : null,
                day.pendingProposals ? countLabel(day.pendingProposals, "pending") : null,
                day.missingDriverRides ? countLabel(day.missingDriverRides, "missingDriver") : null,
                day.conflictRides ? tv("publicationFlow.conflicts", { count: String(day.conflictRides) }) : null,
              ].filter(Boolean).join(" · ")}</span>
            </span>
          </label>)}
          {!selectedDays.length ? <p className="text-sm text-muted-foreground">{he.publicationFlow.noSelection}</p> : null}
        </div> : null}
        {readiness.some((day) => day.unresolvedRequests > 0) ? (
          <p className="text-sm text-muted-foreground">{he.sadranPublish.unresolvedWillBeGrouped}</p>
        ) : null}
      </CardContent></Card>
      {draftRows.length ? (
        <Card className="border-amber-500/60" data-testid="publish-drafts"><CardContent className="space-y-2 p-4 text-sm">
          <h2 className="font-medium">{he.boardDrafts.publishTitle}</h2>
          <p className="text-muted-foreground">{he.boardDrafts.publishHelp}</p>
          <ul className="space-y-1">
            {draftRows.map((row) => (
              <li key={row.id} className="flex flex-wrap items-center justify-between gap-2" data-testid="publish-draft-row">
                <span><span className="font-medium">{dateLabel(row.day)}</span>{" · "}{tv("boardDrafts.publishRow", { name: row.name, type: he.proposal.type[row.type as keyof typeof he.proposal.type] ?? row.type })}</span>
                <Button variant="outline" size="sm" onClick={() => navigate(paths.sadran.board(departmentId, weekStart))}>{he.boardDrafts.publishOpenBoard}</Button>
              </li>
            ))}
          </ul>
        </CardContent></Card>
      ) : draftDays.size ? <p className="text-sm text-amber-700">{he.boardDrafts.publishBlockedDay}</p> : null}
      {alternativeRows.length ? (
        <Card className="border-amber-500/60" data-testid="publish-alternatives"><CardContent className="space-y-2 p-4 text-sm">
          <h2 className="font-medium">{he.sadranPlanB.publishTitle}</h2>
          <p className="text-muted-foreground">{he.sadranPlanB.publishHelp}</p>
          <ul className="space-y-1">
            {alternativeRows.map((row) => (
              <li key={row.id} className="flex flex-wrap items-center justify-between gap-2" data-testid="publish-alternative-row">
                <span><span className="font-medium">{dateLabel(row.day)}</span>{" · "}{tv("sadranPlanB.publishRow", { name: row.name, plan: row.plan })}</span>
                <Button variant="outline" size="sm" onClick={() => navigate(paths.sadran.board(departmentId, weekStart))}>{he.boardDrafts.publishOpenBoard}</Button>
              </li>
            ))}
          </ul>
        </CardContent></Card>
      ) : null}
      <p className="text-sm text-muted-foreground">{he.publishScores.help}</p>
      <RideChangeAnswers departmentId={departmentId} weekStart={weekStart} canManage />
      {savedScores.length ? <Card><CardContent className="overflow-x-auto p-4">
        <h2 className="mb-2 font-medium">{he.publishScores.title}</h2>
        <table className="w-full text-start text-sm">
          <thead><tr><th className="p-2 text-start">{he.publishScores.policy}</th><th className="p-2 text-start">{he.publishScores.served}</th><th className="p-2 text-start">{he.publishScores.priority}</th><th className="p-2 text-start">{he.publishScores.coverage}</th></tr></thead>
          <tbody>{savedScores.map((s) => <tr key={s.policy_version_id} className="border-t">
            <td className="p-2">{s.policy_name}</td>
            <td className="p-2" dir="ltr">{s.served_count} / {s.request_count}</td>
            <td className="p-2" dir="ltr">{s.served_priority_total.toFixed(2)} / {s.priority_total.toFixed(2)}</td>
            <td className="p-2" dir="ltr">{s.alignment_ratio == null ? he.publishScores.noPriority : `${(s.alignment_ratio * 100).toFixed(1)}%`}</td>
          </tr>)}</tbody>
        </table>
      </CardContent></Card> : null}

      <Card>
        <CardContent className="space-y-2 p-4 text-sm">
          <h2 className="font-medium">
            {diff.isFirstPublish
              ? he.sadranPublish.firstPublish
              : tv("sadranPublish.previousVersionLabel", {
                  n: String(previousVersion?.version_no ?? 0),
                  when: previousVersion ? formatTime(new Date(previousVersion.published_at)) : "",
                })}
          </h2>
          <p className="font-medium">{he.sadranPublish.diffTitle}</p>
          <ul className="grid grid-cols-2 gap-1 text-muted-foreground">
            <li>{tv("sadranPublish.diffNewRides", { count: String(diff.newRides) })}</li>
            <li>{tv("sadranPublish.diffChangedTimes", { count: String(diff.changedTimeRides) })}</li>
            <li>{tv("sadranPublish.diffCancelled", { count: String(diff.cancelledRides) })}</li>
            <li>{tv("sadranPublish.diffUnnotified", { count: String(diff.unnotifiedCount) })}</li>
          </ul>
        </CardContent>
      </Card>

      {rides.some((ride) => ride.needs_driver) ? <Card className="border-destructive/50"><CardContent className="p-4 text-sm text-destructive">{he.boardCoordination.missingDriverPublish}</CardContent></Card> : null}

      {conflictCount > 0 ? (
        <Card className="border-destructive/50">
          <CardContent className="p-4 text-sm text-destructive">{he.sadranPublish.blockedByConflicts}</CardContent>
        </Card>
      ) : null}

      <Card>
        <CardContent className="space-y-2 p-4 text-sm">
          <h2 className="font-medium">{tv("sadranPublish.notifyListTitle", { count: String(notifyList.length) })}</h2>
          <ul className="space-y-1 text-muted-foreground">
            {notifyList.map((r) => {
              const placed = placedTimes(r, ridesQuery.data ?? []);
              return (
              <li key={r.id}>
                <TripSummary name={r.requester_full_name} destination={r.destination_resolved_name ?? r.destination_text} purpose={r.ride_type_name_he} departAt={placed.departAt} returnAt={placed.returnAt} />
                {he.status[r.status as keyof typeof he.status] ?? r.status}
              </li>
              );
            })}
          </ul>
        </CardContent>
      </Card>

      {selectedDays ? <Button className="w-full" size="lg" onClick={() => proposePublish(selectedDays)} disabled={unavailable || !selectedDays.length || conflictCount > 0 || selectedDays.some((day) => draftDays.has(day))}>
        {publishMutation.isPending ? he.publishScores.calculating : he.publicationFlow.selectedPublish}
      </Button> : null}
      <ConfirmDialog
        open={!!confirmDays}
        onOpenChange={(open) => !open && setConfirmDays(null)}
        title={he.publicationFlow.unresolvedTitle}
        description={he.publicationFlow.unresolvedHelp}
        confirmLabel={he.publicationFlow.confirmUnresolved}
        loading={publishMutation.isPending}
        onConfirm={() => confirmDays && void handlePublish(confirmDays, true)}
      >
        <ul className="space-y-2 text-sm">{readiness.filter((day) => confirmDays?.includes(day.day) && (day.unresolvedRequests || day.pendingProposals || day.missingDriverRides)).map((day) => <li key={day.day}>
          <span className="font-medium">{dateLabel(day.day)}</span>{" · "}{[
            day.unresolvedRequests ? countLabel(day.unresolvedRequests, "unresolved") : null,
            day.pendingProposals ? countLabel(day.pendingProposals, "pending") : null,
            day.missingDriverRides ? countLabel(day.missingDriverRides, "missingDriver") : null,
          ].filter(Boolean).join(" · ")}
        </li>)}</ul>
        {expiringProposals.length ? (
          <div className="mt-3 space-y-1 text-sm" data-testid="publish-expiring-proposals">
            <p className="font-medium text-maintenance">{he.publicationFlow.expiringTitle}</p>
            <p className="text-muted-foreground">{he.publicationFlow.expiringWhoIsTold}</p>
            <ul className="list-disc ps-5">{expiringProposals.map((row) => <li key={row.id}>{tv("publicationFlow.expiringRow", { name: row.name, type: t(`proposal.type.${row.type}` as TranslationKey), day: dateLabel(row.day) })}</li>)}</ul>
          </div>
        ) : null}
        {pendingProposalRows.length ? (
          <div className="mt-3 space-y-1 text-sm" data-testid="publish-pending-proposals">
            <p className="font-medium">{he.publicationFlow.pendingTitle}</p>
            <ul className="list-disc ps-5">{pendingProposalRows.map((row) => <li key={row.id}>{tv("publicationFlow.pendingRow", {
              name: row.name, type: t(`proposal.type.${row.type}` as TranslationKey), day: dateLabel(row.day),
              expires: row.expires ? formatDayDate(row.expires) + " " + formatTime(new Date(row.expires)) : "",
            })}</li>)}</ul>
          </div>
        ) : null}
      </ConfirmDialog>
    </div>
  );
}
