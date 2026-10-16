import { useState, type ReactNode } from "react";
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

/** The board's primary publish button — always visible in the header, at every width (publishing an open week closes its requests too). */
export function PublishButton({ departmentId, weekStart }: { departmentId: string; weekStart: string }) {
  const navigate = useNavigate();
  const weekQuery = useWeekRow(departmentId, weekStart);
  const archived = weekQuery.data?.phase === "archived";
  return (
    <Button disabled={archived || weekQuery.isLoading} onClick={() => navigate(paths.sadran.publish(departmentId, weekStart))}>
      {he.action.publish}
    </Button>
  );
}

interface CancelPublicationActionProps {
  departmentId: string;
  weekStart: string;
  /**
   * Custom trigger rendering (the board's kebab "actions" menu, UX_FLOWS.md
   * §4.2): defaults to the original inline outline `Button`. Returns `null`
   * entirely once the week is `open` or `archived` (nothing to cancel). The
   * label depends on the phase: "ביטול הפרסום" when published, "פתיחה מחדש
   * לבקשות" when closed but not published (`solving`, owner 2026-10-16).
   */
  renderTrigger?: (props: { onClick: () => void; label: string }) => ReactNode;
}

/**
 * Reversible "cancel publication" (reopen for requests, or unpublish back to solving) with its confirm dialog.
 * A closed, unpublished week (`solving`) has nothing to unpublish: the action only reopens it for requests.
 */
export function CancelPublicationAction({ departmentId, weekStart, renderTrigger }: CancelPublicationActionProps) {
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
  if (!weekQuery.data || weekQuery.data.phase === "open" || archived) return null;
  const closedOnly = weekQuery.data.phase === "solving";
  const target = closedOnly ? "open" : phase;
  const label = closedOnly ? he.publicationFlow.reopen : he.publicationFlow.cancel;
  return <>
    {renderTrigger ? renderTrigger({ onClick: () => setCancelOpen(true), label })
      : <Button variant="outline" onClick={() => setCancelOpen(true)}>{label}</Button>}
    <ConfirmDialog
      open={cancelOpen}
      onOpenChange={setCancelOpen}
      title={closedOnly ? he.publicationFlow.reopen : he.publicationFlow.cancelTitle}
      description={closedOnly ? he.publicationFlow.reopenClosedHelp : phase === "open" ? he.publicationFlow.reopenHelp : he.publicationFlow.unpublishHelp}
      confirmLabel={closedOnly ? he.publicationFlow.reopen : he.publicationFlow.confirmCancel}
      destructive
      loading={reopenMutation.isPending}
      confirmDisabled={!fingerprint.data || fingerprint.isFetching || fingerprint.isError}
      onConfirm={() => {
        if (!fingerprint.data) return;
        reopenMutation.mutate({ departmentId, weekStart, phase: target, expectedFingerprint: fingerprint.data }, {
          onSuccess: () => { setCancelOpen(false); toast.success(closedOnly ? he.publicationFlow.reopened : he.publicationFlow.cancelled); },
        });
      }}
    >
      {closedOnly ? null : <Select value={phase} onValueChange={(value) => setPhase(value as "open" | "solving")}>
        <SelectTrigger aria-label={he.publicationFlow.cancelTitle}><SelectValue /></SelectTrigger>
        <SelectContent><SelectItem value="open">{he.publicationFlow.reopen}</SelectItem><SelectItem value="solving">{he.publicationFlow.unpublish}</SelectItem></SelectContent>
      </Select>}
      {fingerprint.isError ? <ErrorState onRetry={() => void fingerprint.refetch()} /> : null}
    </ConfirmDialog>
  </>;
}
