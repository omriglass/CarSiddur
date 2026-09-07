import { useNavigate } from "react-router-dom";
import { toast } from "sonner";

import { formatWeekRangeLabel } from "@/components/DateField";
import { PageHeader } from "@/components/PageHeader";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Textarea } from "@/components/ui/textarea";
import { useState } from "react";
import { he, tv } from "@/i18n/he";
import { formatTime } from "@/lib/time";

import { requestDayMismatchRideIds, scanBoardConflicts } from "../../board/geometry";
import { computeDiffSummary } from "../diffSummary";
import {
  useAllWeekRides,
  useDepartmentSettings,
  usePublishSiddurMutation,
  useSiddurVersions,
  useWeekRequests,
} from "../../hooks";
import { useDepartments } from "@/features/siddur/hooks";
import { buildWeek } from "@/features/solverBridge/buildSolverInput";
import type { PolicyBoardScore } from "../profileScores";
import { RideChangeAnswers } from "@/features/siddur/components/RideChangeAnswers";

interface PublishScreenProps {
  departmentId: string;
  weekStart: string;
}

/** `/sadran/:dept/:week/publish` — publish confirmation (UX_FLOWS.md §4.5). */
export function PublishScreen({ departmentId, weekStart }: PublishScreenProps) {
  const navigate = useNavigate();
  const [groupMessage, setGroupMessage] = useState("");

  const departmentsQuery = useDepartments();
  const department = (departmentsQuery.data ?? []).find((d) => d.id === departmentId);
  const departmentSettingsQuery = useDepartmentSettings(departmentId);
  const requestsQuery = useWeekRequests(departmentId, weekStart);
  const ridesQuery = useAllWeekRides(departmentId, weekStart);
  const versionsQuery = useSiddurVersions(departmentId, weekStart);
  const publishMutation = usePublishSiddurMutation();

  const versions = versionsQuery.data ?? [];
  const previousVersion = versions[0] ?? null;
  const savedScores = ((previousVersion?.snapshot as { policy_scores?: PolicyBoardScore[] } | null)?.policy_scores ?? []);

  const daySettings = departmentSettingsQuery.data;
  const rides = ridesQuery.data ?? [];
  const conflictCount =
    daySettings && department?.home_destination_id
      ? (() => {
          const validRides = rides.filter(
            (r): r is typeof r & { id: string; car_id: string; starts_at: string; ends_at: string; origin_id: string; destination_id: string } =>
              !!r.id && !!r.car_id && !!r.starts_at && !!r.ends_at && !!r.origin_id && !!r.destination_id,
          );
          const weekStartMs = buildWeek(weekStart, daySettings.day_end_time).startMs;
          const days = buildWeek(weekStart, daySettings.day_end_time).days;
          const conflicts = scanBoardConflicts({
            rides: validRides.map((r) => ({
              id: r.id,
              carId: r.car_id,
              startsAt: r.starts_at,
              endsAt: r.ends_at,
              originId: r.origin_id,
              destinationId: r.destination_id,
              overnightAck: !!r.overnight_ack_by,
            })),
            carIds: [...new Set(validRides.map((r) => r.car_id))],
            weekStartMs,
            bufferMinutes: daySettings.turnaround_minutes,
            homeLocationId: department.home_destination_id,
            days,
          }).conflictRideIds;
          for (const id of requestDayMismatchRideIds(rides, requestsQuery.data ?? [])) conflicts.add(id);
          return conflicts.size;
        })()
      : 0;

  const previousSnapshot = previousVersion?.snapshot as
    | { rides?: { id: string; starts_at: string; ends_at: string; car_id: string; status: string }[]; requests?: { id: string; status: string; status_reason: string | null }[] }
    | undefined;

  const diff = computeDiffSummary({
    previousRides: previousSnapshot?.rides ?? null,
    currentRides: rides
      .filter((r) => r.id && r.starts_at && r.ends_at && r.car_id)
      .map((r) => ({ id: r.id as string, starts_at: r.starts_at as string, ends_at: r.ends_at as string, car_id: r.car_id as string, status: r.status ?? "draft" })),
    previousRequests: previousSnapshot?.requests ?? null,
    currentRequests: (requestsQuery.data ?? [])
      .filter((r) => r.status !== "draft" && r.status !== "withdrawn")
      .map((r) => ({ id: r.id, status: r.status, status_reason: r.status_reason })),
  });

  const notifyList = (requestsQuery.data ?? []).filter((r) => r.status !== "draft" && r.status !== "withdrawn");

  async function handlePublish() {
    try {
      await publishMutation.mutateAsync({ departmentId, weekStart });
      toast.success(he.sadranPublish.successTitle);
      navigate(`/sadran/${departmentId}/${weekStart}`);
    } catch {
      // toast already shown
    }
  }

  return (
    <div className="mx-auto max-w-3xl space-y-4 p-4 pb-24">
      <PageHeader title={he.screen.publish.title} subtitle={formatWeekRangeLabel(weekStart)} />
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
                {r.destination_text ?? ""} — {he.status[r.status as keyof typeof he.status] ?? r.status}
              </li>
            ))}
          </ul>
        </CardContent>
      </Card>

      <Card>
        <CardContent className="space-y-2 p-4">
          <label className="block text-sm font-medium">{he.sadranPublish.groupMessageLabel}</label>
          <Textarea value={groupMessage} onChange={(e) => setGroupMessage(e.target.value)} rows={3} />
        </CardContent>
      </Card>

      <Button
        className="w-full"
        size="lg"
        onClick={handlePublish}
        disabled={conflictCount > 0 || publishMutation.isPending || ridesQuery.isLoading || requestsQuery.isLoading || departmentSettingsQuery.isLoading || departmentsQuery.isLoading || ridesQuery.isError || requestsQuery.isError || departmentSettingsQuery.isError || departmentsQuery.isError}
      >
        {publishMutation.isPending ? he.publishScores.calculating : he.action.publishAndNotify}
      </Button>
    </div>
  );
}
