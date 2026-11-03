import { useActiveDepartment } from "@/features/auth/useActiveDepartment";
import { useSearchParams } from "react-router-dom";

import { RequestOverlay } from "@/app/RequestOverlay";
import { useCloseRequestOverlay, weekShownOnSiddur } from "@/app/overlayState";
import { formatWeekRangeLabel } from "@/components/dateFieldDates";
import { PageHeader } from "@/components/PageHeader";
import { parseHHMM } from "@/components/timeField15Format";
import { useMyDepartments } from "@/features/auth/useMyDepartments";
import { useProfile } from "@/features/auth/useProfile";
import { resolveWeekStart } from "@/features/requests/resolveWeekStart";
import { RequestForm } from "@/features/requests/components/RequestForm";
import { TemplateSuggestions } from "@/features/requests/components/TemplateSuggestions";
import { useTemplateSuggestionsQuery } from "@/features/requests/hooks";
import { useWeeks } from "@/features/siddur/hooks";
import { he } from "@/i18n/he";

const isDayKey = (value: string) => /^\d{4}-\d{2}-\d{2}$/.test(value);
const isTimeOfDay = (value: string) => /^\d{2}:\d{2}$/.test(value) && parseHHMM(value) !== null;

function validParam(value: string | null, valid: (value: string) => boolean): string | undefined {
  return value && valid(value) ? value : undefined;
}

/**
 * `/requests/new` (UX_FLOWS.md §3.4). (The old `?ride=<id>` "ask to join" prefill is gone, owner 2026-11-03:
 * members join a ride themselves with "+ נוסעים".)
 */
export function NewRequestPage() {
  const [searchParams] = useSearchParams();
  const weekOverride = searchParams.get("week") ?? undefined;
  // Quick-request-from-empty-slot on an Open/Solving-week siddur (UX_FLOWS.md §18): the
  // Sadran hasn't solved yet, so there is no car to target — only day/time carry over.
  // A malformed value is dropped here, never handed to the form (an `Invalid Date` there crashed Safari, 2026-10-13).
  const dayParam = validParam(searchParams.get("day"), isDayKey);
  const timeParam = validParam(searchParams.get("time"), isTimeOfDay);
  // Two-tap span on a grid (owner 2026-10-11): the end is "להיות בבית עד", the column's car the preferred car.
  const endParam = validParam(searchParams.get("end"), isTimeOfDay);
  const carParam = searchParams.get("car") ?? undefined;
  const waitlist = searchParams.get("waitlist") === "1";
  // Repeating-request suggestion prefill (UX_FLOWS §3.4, REQ §76).
  const templateId = searchParams.get("template") ?? undefined;
  // REQ §13.157: "הצטרפות לדיון" from a "בדיון" block.
  const joinGroupId = searchParams.get("group") ?? undefined;

  const profileQuery = useProfile();
  const departmentsQuery = useMyDepartments();
  const active = useActiveDepartment();
  const departmentId = active.departmentId;
  const weeksQuery = useWeeks(departmentId);
  const weekStart = resolveWeekStart(weeksQuery.data ?? [], weekOverride);

  const templateSuggestionsQuery = useTemplateSuggestionsQuery();
  const templateSuggestion = templateId
    ? (templateSuggestionsQuery.data ?? []).find((row) => row.templateId === templateId)
    : undefined;

  const isLoading =
    active.isLoading || profileQuery.isLoading || departmentsQuery.isLoading || weeksQuery.isLoading ||
    (!!templateId && templateSuggestionsQuery.isLoading);

  const close = useCloseRequestOverlay();
  const weekOnSiddur = weekShownOnSiddur((weeksQuery.data ?? []).find((week) => week.week_start === weekStart)?.phase);
  const overlay = !!profileQuery.data && !profileQuery.data.classic_request_form;

  const body =
    !isLoading && !active.canSubmit ? <p className="p-4">{he.departmentContext.noMembership}</p> : isLoading || !departmentId || !weekStart ? (
      <div className="space-y-3 p-4">
        <div className="h-11 animate-pulse rounded-md bg-muted" />
        <div className="h-11 animate-pulse rounded-md bg-muted" />
      </div>
    ) : (
      <>
        {!templateId ? (
          <div className="px-4 pt-2">
            <TemplateSuggestions weekStart={weekStart} />
          </div>
        ) : null}
        <RequestForm
          mode="new"
          departmentId={departmentId}
          weekStart={weekStart}
          slotPrefill={dayParam && timeParam ? { day: dayParam, departTime: timeParam, returnTime: endParam, carId: carParam } : undefined}
          dayPrefill={dayParam && !timeParam ? dayParam : undefined}
          carPrefill={!timeParam ? carParam : undefined}
          waitlist={waitlist}
          joinGroupId={joinGroupId}
          templateSuggestion={templateSuggestion}
          onDone={overlay ? (_result, day) => close({ departmentId, weekStart, day, weekOnSiddur }) : undefined}
        />
      </>
    );

  // Sentence layout: an overlay over the page the member came from (UX_FLOWS §3.4a); the classic
  // layout stays the full page.
  if (overlay) {
    return (
      <RequestOverlay
        title={he.screen.request.new}
        subtitle={weekStart ? <span dir="ltr">{formatWeekRangeLabel(weekStart)}</span> : undefined}
      >
        {body}
      </RequestOverlay>
    );
  }

  return (
    <div className="mx-auto max-w-2xl">
      <div className="px-4 pt-2">
        <PageHeader
          title={he.screen.request.new}
          actions={weekStart ? <span className="text-sm text-muted-foreground">{formatWeekRangeLabel(weekStart)}</span> : undefined}
        />
      </div>
      {body}
    </div>
  );
}
