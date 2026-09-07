import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { toast } from "sonner";
import { ErrorState } from "@/components/ErrorState";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { he } from "@/i18n/he";
import { fetchPublishFingerprint } from "../../api";
import { useReopenWeekMutation, useWeekRow } from "../../hooks";

/** The board owns publication and its reversible request-window controls. */
export function BoardPublicationActions({ departmentId, weekStart }: { departmentId: string; weekStart: string }) {
  const navigate = useNavigate();
  const weekQuery = useWeekRow(departmentId, weekStart);
  const reopenMutation = useReopenWeekMutation();
  const [cancelOpen, setCancelOpen] = useState(false);
  const [phase, setPhase] = useState<"open" | "solving">("open");
  const fingerprint = useQuery({
    queryKey: ["sadran", departmentId, weekStart, "reopenFingerprint"],
    queryFn: () => fetchPublishFingerprint(departmentId, weekStart),
    enabled: cancelOpen, staleTime: 0, refetchOnWindowFocus: false,
  });
  const archived = weekQuery.data?.phase === "archived";
  return <>
    <Button disabled={archived || weekQuery.isLoading} onClick={() => navigate(`/sadran/${departmentId}/${weekStart}/publish`)}>
      {weekQuery.data?.phase === "open" ? he.publicationFlow.closeAndPublish : he.action.publish}
    </Button>
    {weekQuery.data && weekQuery.data.phase !== "open" && !archived ? <Button variant="outline" onClick={() => setCancelOpen(true)}>{he.publicationFlow.cancel}</Button> : null}
    <Dialog open={cancelOpen} onOpenChange={(open) => !reopenMutation.isPending && setCancelOpen(open)}>
      <DialogContent>
        <DialogHeader><DialogTitle>{he.publicationFlow.cancelTitle}</DialogTitle><DialogDescription>{phase === "open" ? he.publicationFlow.reopenHelp : he.publicationFlow.unpublishHelp}</DialogDescription></DialogHeader>
        <Select value={phase} onValueChange={(value) => setPhase(value as "open" | "solving")}>
          <SelectTrigger aria-label={he.publicationFlow.cancelTitle}><SelectValue /></SelectTrigger>
          <SelectContent><SelectItem value="open">{he.publicationFlow.reopen}</SelectItem><SelectItem value="solving">{he.publicationFlow.unpublish}</SelectItem></SelectContent>
        </Select>
        {fingerprint.isError ? <ErrorState onRetry={() => void fingerprint.refetch()} /> : null}
        <DialogFooter>
          <Button variant="outline" disabled={reopenMutation.isPending} onClick={() => setCancelOpen(false)}>{he.common.cancel}</Button>
          <Button variant="destructive" disabled={reopenMutation.isPending || !fingerprint.data || fingerprint.isFetching || fingerprint.isError} onClick={() => {
            if (!fingerprint.data) return;
            reopenMutation.mutate({ departmentId, weekStart, phase, expectedFingerprint: fingerprint.data }, {
              onSuccess: () => { setCancelOpen(false); toast.success(he.publicationFlow.cancelled); },
            });
          }}>{he.publicationFlow.confirmCancel}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  </>;
}
