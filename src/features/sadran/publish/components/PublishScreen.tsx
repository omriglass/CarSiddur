import { useNavigate } from "react-router-dom";
import { toast } from "sonner";

import { paths } from "@/app/routes";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { formatWeekRangeLabel } from "@/components/DateField";
import { TripSummary } from "@/components/TripSummary";
import { PageHeader } from "@/components/PageHeader";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { ErrorState } from "@/components/ErrorState";
import { formatInTimeZone } from "date-fns-tz";
import { useState } from "react";
import { he, tv } from "@/i18n/he";
import { weekdayLabel } from "@/lib/dayLabels";
import { TZ, dateKey, formatTime } from "@/lib/time";

import { computeDiffSummary } from "../diffSummary";
import {
  useAllWeekRides,
  usePublicationReadiness,
  usePublishSiddurMutation,
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
  const publishMutation = usePublishSiddurMutation();

  const versions = versionsQuery.data ?? [];
  const previousVersion = versions[0] ?? null;
  const savedScores = ((previousVersion?.snapshot as { policy_scores?: PolicyBoardScore[] } | null)?.policy_scores ?? []);

  const readiness = readinessQuery.data ?? [];
  const allDays = readiness.map((day) => day.day);
  const readyDays = readiness.filter((day) => day.ready).map((day) => day.day);
  const chosenDays = selectedDays ?? allDays;
  const chosen = readiness.filter((day) => chosenDays.includes(day.day));
  const conflictCount = chosen.reduce((count, day) => count + day.conflictRides, 0);
  const rides = (ridesQuery.data ?? []).filter((ride) => ride.starts_at && chosenDays.includes(dateKey(ride.starts_at)));
  const chosenRequests = (requestsQuery.data ?? []).filter((request) => {
    const anchor = request.trip_shape === "one_way_from" ? request.return_at : request.depart_at;
    return anchor && chosenDays.includes(dateKey(anchor));
  });
  const previewQueries = [requestsQuery, ridesQuery, versionsQuery];
  const unavailable = readinessQuery.isLoading || readinessQuery.isError || !readiness.length || publishMutation.isPending || previewQueries.some((query) => query.isLoading || query.isError);
  const dateLabel = (day: string) => `${weekdayLabel(`${day}T12:00:00Z`)} · ${formatInTimeZone(`${day}T12:00:00Z`, TZ, "d/M/yyyy")}`;

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
    if (chosen.some((day) => day.conflictRides > 0)) return;
    // `unresolvedRequests` no longer blocks publication (REQ §13.75) — an unresolved request is
    // auto-approved or grouped at publication time, `incompleteAssignments` is the real defect.
    if (chosen.some((day) => day.incompleteAssignments > 0 || day.pendingProposals > 0 || day.missingDriverRides > 0)) {
      setConfirmDays(days);
    } else void handlePublish(days, false);
  }

  async function handlePublish(days: string[], allowUnanswered: boolean) {
    try {
      await publishMutation.mutateAsync({ departmentId, weekStart, days, allowUnanswered });
      toast.success(he.sadranPublish.successTitle);
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
        <p className="text-sm text-muted-foreground">{readyDays.length === 7 ? he.publicationFlow.allReady : tv("publicationFlow.readiness", { count: String(readyDays.length) })}</p>
        <div className="flex flex-wrap gap-2">
          <Button disabled={unavailable || readiness.some((day) => day.conflictRides > 0)} onClick={() => proposePublish(allDays)}>{publishMutation.isPending ? he.publishScores.calculating : he.publicationFlow.allYes}</Button>
          <Button variant="outline" disabled={unavailable} onClick={() => setSelectedDays(readyDays)}>{he.publicationFlow.onlyReady}</Button>
          <Button variant="ghost" disabled={unavailable} onClick={() => setSelectedDays(chosenDays)}>{he.publicationFlow.selectDays}</Button>
        </div>
        {selectedDays ? <div className="space-y-2 border-t pt-3">
          <p className="text-sm text-muted-foreground">{he.publicationFlow.partialHint}</p>
          {readiness.map((day) => <label key={day.day} className="flex items-start gap-3 rounded-md border p-3 text-sm">
            <Checkbox checked={selectedDays.includes(day.day)} disabled={day.conflictRides > 0 || publishMutation.isPending} onCheckedChange={(checked) => setSelectedDays((current) => checked ? [...(current ?? []), day.day] : (current ?? []).filter((value) => value !== day.day))} />
            <span className="space-y-1">
              <span className="block font-medium">{dateLabel(day.day)}{day.published ? ` · ${he.publicationFlow.published}` : ""}</span>
              <span className="block text-xs text-muted-foreground">{day.ready ? he.publicationFlow.ready : [
                day.unresolvedRequests ? tv("publicationFlow.unresolved", { count: String(day.unresolvedRequests) }) : null,
                day.pendingProposals ? tv("publicationFlow.pending", { count: String(day.pendingProposals) }) : null,
                day.missingDriverRides ? tv("publicationFlow.missingDriver", { count: String(day.missingDriverRides) }) : null,
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
            {notifyList.map((r) => (
              <li key={r.id}>
                <TripSummary name={r.requester_full_name} destination={r.destination_resolved_name ?? r.destination_text} purpose={r.ride_type_name_he} departAt={r.depart_at} returnAt={r.return_at} />
                {he.status[r.status as keyof typeof he.status] ?? r.status}
              </li>
            ))}
          </ul>
        </CardContent>
      </Card>

      {selectedDays ? <Button className="w-full" size="lg" onClick={() => proposePublish(selectedDays)} disabled={unavailable || !selectedDays.length || conflictCount > 0}>
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
            day.unresolvedRequests ? tv("publicationFlow.unresolved", { count: String(day.unresolvedRequests) }) : null,
            day.pendingProposals ? tv("publicationFlow.pending", { count: String(day.pendingProposals) }) : null,
            day.missingDriverRides ? tv("publicationFlow.missingDriver", { count: String(day.missingDriverRides) }) : null,
          ].filter(Boolean).join(" · ")}
        </li>)}</ul>
      </ConfirmDialog>
    </div>
  );
}
