import { Link, useParams } from "react-router-dom";

import { canEditRequest } from "@/features/requests/window";
import { Button } from "@/components/ui/button";
import { PageHeader } from "@/components/PageHeader";
import { RequestForm } from "@/features/requests/components/RequestForm";
import { useRequestQuery } from "@/features/requests/hooks";
import { he } from "@/i18n/he";

/** `/requests/:id/edit` (UX_FLOWS.md §3.4 "Edit mode"). */
export function EditRequestPage() {
  const { id } = useParams<{ id: string }>();
  const requestQuery = useRequestQuery(id);

  return (
    <div className="mx-auto max-w-2xl">
      <div className="p-4 pb-0">
        <PageHeader title={he.screen.request.edit} />
      </div>
      {requestQuery.isLoading ? (
        <div className="space-y-3 p-4">
          <div className="h-11 animate-pulse rounded-md bg-muted" />
          <div className="h-11 animate-pulse rounded-md bg-muted" />
        </div>
      ) : requestQuery.isError || !requestQuery.data ? (
        <p role="alert" className="p-4">{requestQuery.isError ? he.request.submitError : he.request.notFound}</p>
      ) : !canEditRequest(requestQuery.data) ? (
        <div className="space-y-3 p-4">
          <p>{he.request.editWindowClosed}</p>
          <Button asChild variant="outline"><Link to="/requests">{he.requestsList.title}</Link></Button>
        </div>
      ) : (
        <RequestForm
          mode="edit"
          departmentId={requestQuery.data.departmentId}
          weekStart={requestQuery.data.weekStart}
          initial={requestQuery.data}
        />
      )}
    </div>
  );
}
