import { useState } from "react";
import { toast } from "sonner";

import { paths } from "@/app/routes";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { formatWeekRangeLabel } from "@/components/dateFieldDates";
import { TripSummary } from "@/components/TripSummary";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { useCancelReservationMutation } from "@/features/planning/hooks";
import { he } from "@/i18n/he";

import type { TemplateSuggestion } from "../api";
import { RequestLink } from "./RequestLink";
import { useSnoozeTemplateMutation, useStopTemplateMutation, useTemplateSuggestionsQuery } from "../hooks";

interface TemplateSuggestionsProps {
  /**
   * Restricts the shown rows to one week (`/requests/new`'s own top-of-form block, only when
   * `?template=` is absent, UX_FLOWS §3.4). Omitted on Home (§3.3), where every open week's
   * suggestions show, grouped by week when there is more than one.
   */
  weekStart?: string;
}

function groupByWeek(rows: TemplateSuggestion[]): { weekStart: string; rows: TemplateSuggestion[] }[] {
  const byWeek = new Map<string, TemplateSuggestion[]>();
  for (const row of rows) {
    const list = byWeek.get(row.weekStart) ?? [];
    list.push(row);
    byWeek.set(row.weekStart, list);
  }
  return [...byWeek.entries()]
    .sort((a, b) => (a[0] < b[0] ? -1 : 1))
    .map(([weekStart, weekRows]) => ({ weekStart, rows: weekRows }));
}

/**
 * The three actions of one suggestion — use ("הגש/י", prefilled new-request route), snooze ("לא השבוע") and stop
 * repeating (behind a confirm). Shared by the list cards below and the "my rides" week view's suggestion sheet
 * (owner 2026-10-11: tapping a suggestion block gives the same actions).
 */
export function TemplateSuggestionActions({ row, onDone }: { row: TemplateSuggestion; onDone?: () => void }) {
  const snoozeMutation = useSnoozeTemplateMutation();
  const stopMutation = useStopTemplateMutation();
  const cancelReservationMutation = useCancelReservationMutation();
  const [stopOpen, setStopOpen] = useState(false);
  // REQ §13.154 (b): a reservation's suggestion — use it, or "not needed" (cancels the reservation).
  if (row.schedule === "dated") {
    return (
      <div className="flex flex-wrap gap-2 pt-1">
        <Button asChild size="sm">
          <RequestLink to={paths.requests.new({ template: row.templateId, week: row.weekStart })}>{he.request.useSuggestion}</RequestLink>
        </Button>
        <Button
          size="sm"
          variant="outline"
          disabled={cancelReservationMutation.isPending}
          onClick={() => cancelReservationMutation.mutate(row.templateId, { onSuccess: () => { toast.success(he.planning.cancelled); onDone?.(); } })}
          data-testid="reservation-not-needed"
        >
          {he.planning.suggestionNotNeeded}
        </Button>
      </div>
    );
  }
  return (
    <>
      <div className="flex flex-wrap gap-2 pt-1">
        <Button asChild size="sm">
          {/* `week` pins the submission to the week this suggestion was actually
              shown for — without it, `resolveWeekStart` silently falls back to the
              earliest open week, which duplicates an existing request there once a
              member has suggestions across more than one open week. */}
          <RequestLink to={paths.requests.new({ template: row.templateId, week: row.weekStart })}>{he.request.useSuggestion}</RequestLink>
        </Button>
        <Button
          size="sm"
          variant="outline"
          onClick={() =>
            snoozeMutation.mutate(
              { templateId: row.templateId, weekStart: row.weekStart },
              { onSuccess: () => { toast.success(he.request.snoozed); onDone?.(); } },
            )
          }
        >
          {he.request.snoozeSuggestion}
        </Button>
        <Button size="sm" variant="ghost" onClick={() => setStopOpen(true)}>
          {he.request.stopSuggestion}
        </Button>
      </div>
      <ConfirmDialog
        open={stopOpen}
        onOpenChange={setStopOpen}
        title={he.request.stopSuggestionConfirmTitle}
        description={he.request.stopSuggestionConfirmBody}
        destructive
        loading={stopMutation.isPending}
        onConfirm={() => {
          stopMutation.mutate(row.templateId, {
            onSuccess: () => {
              toast.success(he.request.stopped);
              setStopOpen(false);
              onDone?.();
            },
          });
        }}
      />
    </>
  );
}

/**
 * Dismissable repeating-request suggestions (`v_request_template_suggestions`, REQ §76,
 * UX_FLOWS §3.3/§3.4) — one compact card per row; "הגש/י" navigates to the prefilled
 * new-request route, "לא השבוע" snoozes to next week, "הפסק/י לחזור" stops the template for
 * good (behind a confirm). Renders nothing while there are no rows for the given scope.
 */
export function TemplateSuggestions({ weekStart }: TemplateSuggestionsProps) {
  const suggestionsQuery = useTemplateSuggestionsQuery();

  const rows = (suggestionsQuery.data ?? []).filter((row) => !weekStart || row.weekStart === weekStart);
  if (rows.length === 0) return null;

  const groups = groupByWeek(rows);

  return (
    <section className="space-y-3" data-testid="template-suggestions">
      <h2 className="text-sm font-semibold text-muted-foreground">{he.request.suggestionsTitle}</h2>
      {groups.map((group) => (
        <div key={group.weekStart} className="space-y-2">
          {groups.length > 1 ? (
            <p className="text-xs text-muted-foreground" dir="ltr">{formatWeekRangeLabel(group.weekStart)}</p>
          ) : null}
          {group.rows.map((row) => (
            <Card key={row.templateId} className="bg-gradient-card shadow-card">
              <CardContent className="space-y-2 p-3 text-sm">
                {row.schedule === "dated" ? <Badge variant="outline" data-testid="reservation-suggestion">{he.planning.suggestionBadge}</Badge> : null}
                <TripSummary
                  destination={row.destinationName ?? row.destinationText ?? ""}
                  purpose={row.rideTypeName ?? ""}
                  departAt={row.departAt}
                  returnAt={row.returnAt}
                />
                <TemplateSuggestionActions row={row} />
              </CardContent>
            </Card>
          ))}
        </div>
      ))}

    </section>
  );
}
