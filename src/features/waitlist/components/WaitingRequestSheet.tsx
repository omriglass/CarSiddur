import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";

import { paths } from "@/app/routes";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { PortalSheetContent } from "@/components/PortalSheetContent";
import { Button } from "@/components/ui/button";
import { Sheet, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { RequestLink } from "@/features/requests/components/RequestLink";
import { useWithdrawRequestMutation } from "@/features/requests/hooks";
import { he, tv } from "@/i18n/he";
import { formatDayDate } from "@/lib/dayLabels";
import { formatTime } from "@/lib/time";

import { waitlistKeys } from "../keys";
import { waitingPeople } from "../siddurLanes";
import { TRIP_TYPE_LABEL, waitingRoute } from "../waitingLabels";
import type { WaitingRequest } from "../types";

/**
 * REQ §13.182: what a waiting request is - who, when, where, which trip - for every member of the
 * department. On my own request (or one I filed) also "edit" and "remove request" (`myVersion` is
 * that request's version from my own list). REQ §13.183: a private car's owner may put it on that car
 * ("שיבוץ ברכב שלי", `myCars`) — the requester drives it.
 */
export function WaitingRequestSheet({ request, myVersion, myCars = [], onAssignToCar, onOpenChange }: {
  request: WaitingRequest | null;
  myVersion?: number;
  /** My active private cars; empty = no "assign to my car". */
  myCars?: readonly { id: string; name: string }[];
  onAssignToCar?: (carId: string, carName: string) => void;
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
              {onAssignToCar && request.trip_type === "round_trip" && myCars.length ? (
                <div className="mb-2 flex flex-col gap-2">
                  {myCars.map((car) => (
                    <Button key={car.id} type="button" data-testid="waiting-assign-my-car" onClick={() => onAssignToCar(car.id, car.name)}>
                      {myCars.length === 1 ? he.waitlist.assignToMyCar : tv("waitlist.assignToCar", { car: car.name })}
                    </Button>
                  ))}
                </div>
              ) : null}
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
