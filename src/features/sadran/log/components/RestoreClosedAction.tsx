// REQ §13.162 (d): "החזר לרשימת ההמתנה" on a closed request's change-log row (Sadran only, for mistakes): the request
// goes back on the waiting list and the member's close notice is taken back (a push already delivered stays).
import { useState } from "react";
import { toast } from "sonner";

import { ConfirmDialog } from "@/components/ConfirmDialog";
import { Button } from "@/components/ui/button";
import { he, tv } from "@/i18n/he";

import { useRestoreClosedRequestMutation } from "../../hooks";

export interface RestoreClosedActionProps {
  requestId: string;
  version: number;
  name: string;
  departmentId: string;
  weekStart: string;
}

export function RestoreClosedAction({ requestId, version, name, departmentId, weekStart }: RestoreClosedActionProps) {
  const [open, setOpen] = useState(false);
  const mutation = useRestoreClosedRequestMutation();
  function confirm() {
    mutation.mutate({ requestId, expectedVersion: version, departmentId, weekStart }, {
      onSuccess: () => { setOpen(false); toast.success(tv("closeRequest.restoreDone", { name })); },
    });
  }
  return (
    <>
      <Button type="button" size="sm" variant="outline" className="min-h-11" onClick={() => setOpen(true)} data-testid="change-log-restore">
        {he.closeRequest.restore}
      </Button>
      <ConfirmDialog
        open={open}
        onOpenChange={setOpen}
        title={tv("closeRequest.restoreTitle", { name })}
        description={he.closeRequest.restoreDescription}
        confirmLabel={he.closeRequest.restore}
        loading={mutation.isPending}
        onConfirm={confirm}
      />
    </>
  );
}
