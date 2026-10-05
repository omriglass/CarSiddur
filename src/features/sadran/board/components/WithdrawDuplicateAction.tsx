// REQ §13.101 (e, QM4): the Sadran withdraws a request as a duplicate ("משיכה ככפילות"). The
// member is notified and may answer "not a duplicate", which restores the request. Not offered for
// multi-day series requests (the RPC refuses them).
import { useState } from "react";
import { toast } from "sonner";

import { ConfirmDialog } from "@/components/ConfirmDialog";
import { Button } from "@/components/ui/button";
import { he, tv } from "@/i18n/he";

import { useWithdrawDuplicateRequestMutation } from "../../hooks";

export interface WithdrawDuplicateActionProps {
  requestId: string;
  version: number | null | undefined;
  name: string;
  departmentId: string;
  weekStart: string;
  disabled?: boolean;
}

export function WithdrawDuplicateAction({ requestId, version, name, departmentId, weekStart, disabled }: WithdrawDuplicateActionProps) {
  const [open, setOpen] = useState(false);
  const mutation = useWithdrawDuplicateRequestMutation();
  if (version == null) return null;
  const expectedVersion = version;
  function confirm() {
    mutation.mutate({ requestId, expectedVersion, departmentId, weekStart }, {
      onSuccess: () => { setOpen(false); toast.success(tv("withdrawDuplicate.done", { name })); },
    });
  }
  return (
    <>
      <Button type="button" size="sm" variant="outline" className="min-h-11" disabled={disabled || mutation.isPending} onClick={() => setOpen(true)}
        data-testid="withdraw-duplicate" data-duplicate-request-id={requestId}>
        {he.withdrawDuplicate.action}
      </Button>
      <ConfirmDialog
        open={open}
        onOpenChange={setOpen}
        title={tv("withdrawDuplicate.title", { name })}
        description={he.withdrawDuplicate.description}
        confirmLabel={he.withdrawDuplicate.confirm}
        destructive
        loading={mutation.isPending}
        onConfirm={confirm}
      />
    </>
  );
}
