import { Link, useParams } from "react-router-dom";

import { RequestOverlay } from "@/app/RequestOverlay";
import { useCloseRequestOverlay } from "@/app/overlayState";
import { paths } from "@/app/routes";
import { formatWeekRangeLabel } from "@/components/dateFieldDates";
import { useProfile } from "@/features/auth/useProfile";
import { canEditRequest } from "@/features/requests/window";
import { Button } from "@/components/ui/button";
import { PageHeader } from "@/components/PageHeader";
import { SeriesRequestPanel } from "@/features/requests/components/SeriesRequestPanel";
import { RequestForm } from "@/features/requests/components/RequestForm";
import { useRequestQuery } from "@/features/requests/hooks";
import { he } from "@/i18n/he";

/** `/requests/:id/edit` (UX_FLOWS.md §3.4 "Edit mode"). */
export function EditRequestPage() {
  const { id } = useParams<{ id: string }>();
  const requestQuery = useRequestQuery(id);

  const profileQuery = useProfile();
  const close = useCloseRequestOverlay();
  const overlay = !!profileQuery.data && !profileQuery.data.classic_request_form;

  const body = requestQuery.isLoading ? (
    <div className="space-y-3 p-4">
      <div className="h-11 animate-pulse rounded-md bg-muted" />
      <div className="h-11 animate-pulse rounded-md bg-muted" />
    </div>
  ) : requestQuery.isError || !requestQuery.data ? (
    <p role="alert" className="p-4">{requestQuery.isError ? he.request.submitError : he.request.notFound}</p>
  ) : requestQuery.data.seriesId ? (
    // A multi-day request is never edited, only shortened or cancelled (REQ §13.77).
    <SeriesRequestPanel seriesId={requestQuery.data.seriesId} />
  ) : !canEditRequest(requestQuery.data) ? (
    <div className="space-y-3 p-4">
      <p>{he.request.editWindowClosed}</p>
      <Button asChild variant="outline"><Link to={paths.my()} replace={overlay}>{he.requestsList.title}</Link></Button>
    </div>
  ) : (
    <RequestForm
      mode="edit"
      departmentId={requestQuery.data.departmentId}
      weekStart={requestQuery.data.weekStart}
      initial={requestQuery.data}
      onDone={overlay ? close : undefined}
    />
  );

  // Sentence layout: an overlay over the page the member came from (UX_FLOWS §3.4a).
  if (overlay) {
    return (
      <RequestOverlay
        title={he.screen.request.edit}
        subtitle={requestQuery.data ? <span dir="ltr">{formatWeekRangeLabel(requestQuery.data.weekStart)}</span> : undefined}
      >
        {body}
      </RequestOverlay>
    );
  }

  return (
    <div className="mx-auto max-w-2xl">
      <div className="p-4 pb-0">
        <PageHeader title={he.screen.request.edit} />
      </div>
      {body}
    </div>
  );
}
