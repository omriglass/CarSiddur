// REQ §13.162 (b): "הנסיעה כבר לא רלוונטית" on a waiting request's ⋮ menu (unmet card): the request is closed - it
// leaves the waiting list and the board and is never offered a car. Same wording as the ride sheet's cancel dialog.
import { useState } from "react";
import { toast } from "sonner";

import { ConfirmDialog } from "@/components/ConfirmDialog";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { he, tv } from "@/i18n/he";

import { useCloseRequestMutation } from "../../hooks";

export interface CloseRequestActionProps {
  requestId: string;
  version: number | null | undefined;
  name: string;
  departmentId: string;
  weekStart: string;
  /** A multi-day request: every day is closed. */
  series?: boolean;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function CloseRequestAction({ requestId, version, name, departmentId, weekStart, series, open, onOpenChange }: CloseRequestActionProps) {
  const [reason, setReason] = useState("");
  const mutation = useCloseRequestMutation();
  if (version == null) return null;
  const expectedVersion = version;
  function change(next: boolean) {
    if (!next) setReason("");
    onOpenChange(next);
  }
  function confirm() {
    mutation.mutate({ requestId, expectedVersion, reason: reason.trim(), departmentId, weekStart }, {
      onSuccess: () => { change(false); toast.success(tv("closeRequest.done", { name })); },
    });
  }
  return (
    <ConfirmDialog
      open={open}
      onOpenChange={change}
      title={tv("closeRequest.title", { name })}
      description={he.closeRequest.closeHint}
      confirmLabel={he.closeRequest.confirm}
      destructive
      loading={mutation.isPending}
      onConfirm={confirm}
    >
      <div className="space-y-3" data-testid="close-request-dialog">
        {series ? <p className="text-sm text-muted-foreground">{he.closeRequest.seriesNote}</p> : null}
        <p role="alert" className="rounded-md border border-destructive/50 bg-destructive/5 p-2 text-sm font-medium text-destructive">
          {he.closeRequest.closeWarning}
        </p>
        <div className="space-y-1">
          <Label htmlFor="close-request-reason">{he.closeRequest.reasonLabel}</Label>
          <Textarea id="close-request-reason" value={reason} onChange={(event) => setReason(event.target.value)} placeholder={he.closeRequest.reasonPlaceholder} />
          <p className="text-xs text-muted-foreground">{he.closeRequest.reasonHint}</p>
        </div>
      </div>
    </ConfirmDialog>
  );
}
