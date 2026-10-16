import { Link, useLocation, useParams } from "react-router-dom";

import { RequestOverlay } from "@/app/RequestOverlay";
import { readOverlayFrom, useCloseRequestOverlay } from "@/app/overlayState";
import { paths } from "@/app/routes";
import { formatWeekRangeLabel } from "@/components/dateFieldDates";
import { useIsSadran } from "@/features/auth/useIsSadran";
import { useProfile } from "@/features/auth/useProfile";
import { canEditRequest } from "@/features/requests/window";
import { Button } from "@/components/ui/button";
import { PageHeader } from "@/components/PageHeader";
import { SeriesRequestPanel } from "@/features/requests/components/SeriesRequestPanel";
import { RequestForm } from "@/features/requests/components/RequestForm";
import { useCanEditRequestQuery, useRequestQuery } from "@/features/requests/hooks";
import { he } from "@/i18n/he";

/** `/requests/:id/edit` (UX_FLOWS.md §3.4 "Edit mode"). */
export function EditRequestPage() {
  const { id } = useParams<{ id: string }>();
  const requestQuery = useRequestQuery(id);
  // REQ §13.127 (b): the server decides who is related to the request.
  const canEditQuery = useCanEditRequestQuery(id);

  const profileQuery = useProfile();
  const close = useCloseRequestOverlay();
  // Owner 2026-10-16: opened from the board's unplaced card -> save returns there; the Sadran (can_manage_week)
  // edits regardless of the member's closing time (the server allows it: submit_request `v_can_manage`).
  const cameFromPage = !!readOverlayFrom(useLocation().state);
  const sadran = useIsSadran(requestQuery.data?.departmentId, requestQuery.data?.weekStart).isSadran;
  const overlay = !!profileQuery.data && !profileQuery.data.classic_request_form;

  const body = requestQuery.isLoading || canEditQuery.isLoading ? (
    <div className="space-y-3 p-4">
      <div className="h-11 animate-pulse rounded-md bg-muted" />
      <div className="h-11 animate-pulse rounded-md bg-muted" />
    </div>
  ) : requestQuery.isError || canEditQuery.isError ? (
    <p role="alert" className="p-4">{he.request.submitError}</p>
  ) : !requestQuery.data || !canEditQuery.data ? (
    <p role="alert" className="p-4">{he.request.notFound}</p>
  ) : requestQuery.data.seriesId ? (
    // A multi-day request is never edited, only shortened or cancelled (REQ §13.77).
    <SeriesRequestPanel seriesId={requestQuery.data.seriesId} />
  ) : !(sadran && requestQuery.data.status !== "withdrawn" && requestQuery.data.status !== "cancelled") && !canEditRequest(requestQuery.data) ? (
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
      onDone={overlay || cameFromPage ? close : undefined}
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
