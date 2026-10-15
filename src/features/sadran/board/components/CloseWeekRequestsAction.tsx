import { useState, type ReactNode } from "react";
import { toast } from "sonner";

import { ConfirmDialog } from "@/components/ConfirmDialog";
import { Button } from "@/components/ui/button";
import { he } from "@/i18n/he";

import { useCloseWeekRequestsMutation, useWeekRow } from "../../hooks";

interface CloseWeekRequestsActionProps {
  departmentId: string;
  weekStart: string;
  /** The board's kebab menu passes its own `DropdownMenuItem`; defaults to a plain outline button. */
  renderTrigger?: (props: { onClick: () => void }) => ReactNode;
}

/**
 * Sadran-only "close requests now" (`close_week_requests` RPC): closes the request window of an
 * `open` week (typically after "reopen for requests") without publishing. Hidden in every other phase.
 */
export function CloseWeekRequestsAction({ departmentId, weekStart, renderTrigger }: CloseWeekRequestsActionProps) {
  const weekQuery = useWeekRow(departmentId, weekStart);
  const mutation = useCloseWeekRequestsMutation();
  const [open, setOpen] = useState(false);
  if (weekQuery.data?.phase !== "open") return null;
  return <>
    {renderTrigger ? renderTrigger({ onClick: () => setOpen(true) }) : (
      <Button type="button" variant="outline" onClick={() => setOpen(true)}>{he.weekClose.closeNow}</Button>
    )}
    <ConfirmDialog
      open={open}
      onOpenChange={setOpen}
      title={he.weekClose.closeNow}
      description={he.weekClose.closeNowHelp}
      confirmLabel={he.weekClose.closeNow}
      loading={mutation.isPending}
      onConfirm={() => mutation.mutate({ departmentId, weekStart }, {
        onSuccess: () => { setOpen(false); toast.success(he.weekClose.closedNow); },
      })}
    />
  </>;
}
