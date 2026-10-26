import { useNavigate, useParams, useSearchParams } from "react-router-dom";

import { paths } from "@/app/routes";
import { formatWeekRangeLabel } from "@/components/dateFieldDates";
import { ErrorState } from "@/components/ErrorState";
import { PageHeader } from "@/components/PageHeader";
import { weekStartKey } from "@/features/planning/api";
import { useOwnReservationQuery } from "@/features/planning/hooks";
import { RequestForm } from "@/features/requests/components/RequestForm";
import { he } from "@/i18n/he";

const isDayKey = (value: string | null): value is string => !!value && /^\d{4}-\d{2}-\d{2}$/.test(value);

/**
 * `/plan/:dept/new?day=` and `/plan/:dept/:reservationId/edit` — a reservation (REQ §13.154 a) is filled in the ordinary
 * request form (every field a request has); saving stores it as a dated saved request, never as a request.
 */
export function ReservationFormPage() {
  const { dept, reservationId } = useParams<{ dept: string; reservationId?: string }>();
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const dayParam = searchParams.get("day");
  const reservationQuery = useOwnReservationQuery(reservationId);
  const existing = reservationQuery.data;
  const day = existing ? undefined : isDayKey(dayParam) ? dayParam : undefined;
  const weekStart = existing ? existing.weekStart : day ? weekStartKey(day) : undefined;

  return (
    <div className="mx-auto max-w-2xl">
      <div className="space-y-2 px-4 pt-2">
        <PageHeader
          title={reservationId ? he.planning.formTitleEdit : he.planning.formTitleNew}
          actions={weekStart ? <span className="text-sm text-muted-foreground" dir="ltr">{formatWeekRangeLabel(weekStart)}</span> : undefined}
        />
        <p className="rounded-md bg-primary/5 p-3 text-sm" data-testid="reservation-intro">{he.planning.formIntro}</p>
      </div>
      {reservationQuery.isError ? (
        <ErrorState onRetry={() => void reservationQuery.refetch()} />
      ) : !dept || !weekStart || (reservationId && !existing) ? (
        <div className="space-y-3 p-4">
          <div className="h-11 animate-pulse rounded-md bg-muted" />
          <div className="h-11 animate-pulse rounded-md bg-muted" />
        </div>
      ) : (
        <RequestForm
          key={existing?.templateId ?? day}
          mode="new"
          departmentId={dept}
          weekStart={weekStart}
          dayPrefill={day}
          templateSuggestion={existing}
          reservation={{ id: reservationId }}
          onDone={() => navigate(paths.plan(dept))}
        />
      )}
    </div>
  );
}
