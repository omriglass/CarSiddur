import { useParams } from "react-router-dom";

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
      {requestQuery.isLoading || !requestQuery.data ? (
        <div className="space-y-3 p-4">
          <div className="h-11 animate-pulse rounded-md bg-muted" />
          <div className="h-11 animate-pulse rounded-md bg-muted" />
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
