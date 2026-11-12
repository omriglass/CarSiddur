// REQ §13.101 (e, QM4): the Sadran withdraws a request as a duplicate ("משיכה ככפילות"). The
// member is notified and may answer "not a duplicate", which restores the request. Not offered for
// multi-day series requests (the RPC refuses them).
import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { toast } from "sonner";

import { ConfirmDialog } from "@/components/ConfirmDialog";
import { Button } from "@/components/ui/button";
import { he, tv } from "@/i18n/he";
import type { BoardRide } from "@/features/rides/api";
import { formatDayDate } from "@/lib/dayLabels";
import { formatTime } from "@/lib/time";
import { cn } from "@/lib/utils";

import { useWithdrawDuplicateRequestMutation } from "../../hooks";
import { sadranKeys } from "../../keys";
import { useRecordBoardUndo } from "../boardUndo";
import { duplicateEffects } from "../duplicateEffects";

export interface WithdrawDuplicateActionProps {
  requestId: string;
  version: number | null | undefined;
  name: string;
  departmentId: string;
  weekStart: string;
  disabled?: boolean;
  /** The inline trigger's extra classes (the ride sheet's actions tab makes it full width like its neighbours). */
  className?: string;
  /** Controlled mode (the unmet card's "⋮" menu opens it): no inline trigger button is rendered. */
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
}

export function WithdrawDuplicateAction({ requestId, version, name, departmentId, weekStart, disabled, className, open: controlledOpen, onOpenChange }: WithdrawDuplicateActionProps) {
  const [localOpen, setLocalOpen] = useState(false);
  const controlled = onOpenChange !== undefined;
  const open = controlled ? !!controlledOpen : localOpen;
  const setOpen = controlled ? onOpenChange : setLocalOpen;
  const mutation = useWithdrawDuplicateRequestMutation();
  const recordUndo = useRecordBoardUndo();
  const queryClient = useQueryClient();
  if (version == null) return null;
  // Read from the board's cached week (no extra call): the rides this withdrawal changes.
  const effects = open ? duplicateEffects(queryClient.getQueryData<BoardRide[]>(sadranKeys.boardRides(departmentId, weekStart)) ?? [], requestId) : [];
  const expectedVersion = version;
  function confirm() {
    void recordUndo(he.sadranBoard.undoLabel.duplicate, () => mutation.mutateAsync({ requestId, expectedVersion, departmentId, weekStart }, {
      onSuccess: () => { setOpen(false); toast.success(tv("withdrawDuplicate.done", { name })); },
    })).catch(() => undefined);
  }
  return (
    <>
      {controlled ? null : (
        <Button type="button" size="sm" variant="outline" className={cn("min-h-11", className)} disabled={disabled || mutation.isPending} onClick={() => setOpen(true)}
          data-testid="withdraw-duplicate" data-duplicate-request-id={requestId}>
          {he.withdrawDuplicate.action}
        </Button>
      )}
      <ConfirmDialog
        open={open}
        onOpenChange={setOpen}
        title={tv("withdrawDuplicate.title", { name })}
        description={effects.length === 0 ? he.withdrawDuplicate.description : (
          <span className="block space-y-2">
            <span className="block">{he.withdrawDuplicate.description}</span>
            <span className="block font-medium text-foreground" data-testid="withdraw-duplicate-effects">
              {he.withdrawDuplicate.effectsTitle}
              {effects.map((effect) => (
                <span key={effect.rideId} className="block font-normal">
                  {"• "}
                  {tv(effect.kind === "own" ? "withdrawDuplicate.effectOwn" : effect.driverName ? "withdrawDuplicate.effectGuest" : "withdrawDuplicate.effectGuestNoDriver",
                    { name, driver: effect.driverName ?? "", day: formatDayDate(effect.startsAt), time: formatTime(new Date(effect.startsAt)) })}
                </span>
              ))}
            </span>
          </span>
        )}
        confirmLabel={he.withdrawDuplicate.confirm}
        destructive
        loading={mutation.isPending}
        onConfirm={confirm}
      />
    </>
  );
}
