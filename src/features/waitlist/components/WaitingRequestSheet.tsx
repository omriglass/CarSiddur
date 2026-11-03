import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";

import { paths } from "@/app/routes";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { PortalSheetContent } from "@/components/PortalSheetContent";
import { Button } from "@/components/ui/button";
import { Sheet, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { RequestLink } from "@/features/requests/components/RequestLink";
import { useWithdrawRequestMutation } from "@/features/requests/hooks";
import { he } from "@/i18n/he";
import { formatDayDate } from "@/lib/dayLabels";
import { formatTime } from "@/lib/time";

import { waitlistKeys } from "../keys";
import { waitingPeople } from "../siddurLanes";
import { TRIP_TYPE_LABEL, waitingRoute } from "../waitingLabels";
import type { WaitingRequest } from "../types";

/**
 * REQ §13.182: what a waiting request is - who, when, where, which trip - for every member of the
 * department. On my own request (or one I filed) also "edit" and "remove request" (`myVersion` is
 * that request's version from my own list).
 */
export function WaitingRequestSheet({ request, myVersion, onOpenChange }: {
  request: WaitingRequest | null;
  myVersion?: number;
  onOpenChange: (open: boolean) => void;
}) {
  const queryClient = useQueryClient();
  const withdraw = useWithdrawRequestMutation();
  const [confirmWithdraw, setConfirmWithdraw] = useState(false);

  async function handleWithdraw() {
    if (!request || myVersion == null) return;
    await withdraw.mutateAsync({ requestId: request.request_id, expectedVersion: myVersion });
    void queryClient.invalidateQueries({ queryKey: waitlistKeys.all });
    setConfirmWithdraw(false);
    onOpenChange(false);
  }

  return (
    <>
      <Sheet open={!!request} onOpenChange={onOpenChange}>
        <PortalSheetContent side="bottom" className="max-h-[85dvh] overflow-y-auto" data-testid="siddur-waiting-sheet">
          {request ? (
            <>
              <SheetHeader>
                <SheetTitle>{he.waitlist.waitingSheetTitle}</SheetTitle>
                <SheetDescription>{he.waitlist.waitingSheetHint}</SheetDescription>
              </SheetHeader>
              <dl className="space-y-3 py-4">
                <div>
                  <dt className="text-sm text-muted-foreground">{he.waitlist.waitingWho}</dt>
                  <dd className="font-medium">{waitingPeople(request).join(", ")}</dd>
                </div>
                <div>
                  <dt className="text-sm text-muted-foreground">{he.waitlist.waitingWhen}</dt>
                  <dd>
                    {formatDayDate(request.starts_at)} ·{" "}
                    <span dir="ltr">{formatTime(new Date(request.starts_at))}–{formatTime(new Date(request.ends_at))}</span>
                  </dd>
                </div>
                <div>
                  <dt className="text-sm text-muted-foreground">{he.waitlist.waitingRoute}</dt>
                  <dd>{waitingRoute(request)}</dd>
                </div>
                <div>
                  <dt className="text-sm text-muted-foreground">{he.waitlist.waitingTripType}</dt>
                  <dd>{TRIP_TYPE_LABEL[request.trip_type]}</dd>
                </div>
              </dl>
              {request.is_mine ? (
                <div className="flex gap-2">
                  <Button asChild variant="outline" className="flex-1">
                    <RequestLink to={paths.requests.edit(request.request_id)} onClick={() => onOpenChange(false)}>{he.requestsList.edit}</RequestLink>
                  </Button>
                  {myVersion != null ? (
                    <Button type="button" variant="destructive" className="flex-1" onClick={() => setConfirmWithdraw(true)}>
                      {he.requestsList.withdraw}
                    </Button>
                  ) : null}
                </div>
              ) : null}
            </>
          ) : null}
        </PortalSheetContent>
      </Sheet>
      <ConfirmDialog
        open={confirmWithdraw}
        onOpenChange={setConfirmWithdraw}
        title={he.request.withdrawConfirmTitle}
        description={he.request.withdrawConfirmBody}
        confirmLabel={he.requestsList.withdraw}
        destructive
        onConfirm={() => void handleWithdraw()}
      />
    </>
  );
}
