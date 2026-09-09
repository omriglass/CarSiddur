import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { toast } from "sonner";
import { paths } from "@/app/routes";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { ErrorState } from "@/components/ErrorState";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { he } from "@/i18n/he";
import { fetchPublishFingerprint } from "../../api";
import { useReopenWeekMutation, useWeekRow } from "../../hooks";
import { sadranKeys } from "../../keys";

/** The board owns publication and its reversible request-window controls. */
export function BoardPublicationActions({ departmentId, weekStart }: { departmentId: string; weekStart: string }) {
  const navigate = useNavigate();
  const weekQuery = useWeekRow(departmentId, weekStart);
  const reopenMutation = useReopenWeekMutation();
  const [cancelOpen, setCancelOpen] = useState(false);
  const [phase, setPhase] = useState<"open" | "solving">("open");
  const fingerprint = useQuery({
    queryKey: sadranKeys.reopenFingerprint(departmentId, weekStart),
    queryFn: () => fetchPublishFingerprint(departmentId, weekStart),
    enabled: cancelOpen, staleTime: 0, refetchOnWindowFocus: false,
  });
  const archived = weekQuery.data?.phase === "archived";
  return <>
    <Button disabled={archived || weekQuery.isLoading} onClick={() => navigate(paths.sadran.publish(departmentId, weekStart))}>
      {weekQuery.data?.phase === "open" ? he.publicationFlow.closeAndPublish : he.action.publish}
    </Button>
    {weekQuery.data && weekQuery.data.phase !== "open" && !archived ? <Button variant="outline" onClick={() => setCancelOpen(true)}>{he.publicationFlow.cancel}</Button> : null}
    <ConfirmDialog
      open={cancelOpen}
      onOpenChange={setCancelOpen}
      title={he.publicationFlow.cancelTitle}
      description={phase === "open" ? he.publicationFlow.reopenHelp : he.publicationFlow.unpublishHelp}
      confirmLabel={he.publicationFlow.confirmCancel}
      destructive
      loading={reopenMutation.isPending}
      confirmDisabled={!fingerprint.data || fingerprint.isFetching || fingerprint.isError}
      onConfirm={() => {
        if (!fingerprint.data) return;
        reopenMutation.mutate({ departmentId, weekStart, phase, expectedFingerprint: fingerprint.data }, {
          onSuccess: () => { setCancelOpen(false); toast.success(he.publicationFlow.cancelled); },
        });
      }}
    >
      <Select value={phase} onValueChange={(value) => setPhase(value as "open" | "solving")}>
        <SelectTrigger aria-label={he.publicationFlow.cancelTitle}><SelectValue /></SelectTrigger>
        <SelectContent><SelectItem value="open">{he.publicationFlow.reopen}</SelectItem><SelectItem value="solving">{he.publicationFlow.unpublish}</SelectItem></SelectContent>
      </Select>
      {fingerprint.isError ? <ErrorState onRetry={() => void fingerprint.refetch()} /> : null}
    </ConfirmDialog>
  </>;
}
