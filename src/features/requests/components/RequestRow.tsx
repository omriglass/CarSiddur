import { Repeat } from "lucide-react";
import type { Ref } from "react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { StatusBadge } from "@/components/StatusBadge";
import { TripSummary } from "@/components/TripSummary";
import { CarHandoverNotice } from "@/features/rides/components/CarHandoverNotice";
import { OpenProposalButton } from "@/features/proposals/components/OpenProposalButton";
import { OpenWaitlistGroupButton } from "@/features/waitlist/components/OpenWaitlistGroupButton";
import { he, tv } from "@/i18n/he";
import { knownStatusReason } from "@/lib/statusReason";
import { cn } from "@/lib/utils";
import { paths } from "@/app/routes";

import type { TripType } from "@/lib/enums";

import type { CarHandoverNotes } from "@/features/rides/carHandover";

import { enteredTimeLabels, type EnteredTimeLabels } from "../enteredTimes";
import { canEditRequest } from "../window";
import { RequestLink } from "./RequestLink";
import { PlanBLines } from "./PlanBLines";
import { WindowSummaryLine } from "./WindowSummaryLine";
import { isAwaitingAnswer } from "../pendingProposal";
import { canPlaceOnOwnCar, isDuplicateWithdrawn } from "../overlap";
import { FREED_SLOT_ELIGIBLE_STATUSES, MAKE_REPEATING_STATUSES, displayStatus, legStateLine, originDestinationLabel, ownLegWindow, type DisplayRow } from "../myRequestsRows";

/** REQ §13.93: shown whenever a request is not a plain round trip (the mundane default). */
const TRIP_TYPE_LABEL: Record<TripType, string> = {
  round_trip: he.request.tripTypeRoundTrip,
  one_way: he.request.tripTypeOneWay,
  drop_off: he.request.tripTypeDropOff,
};

interface RequestRowProps {
  row: DisplayRow;
  /** Ring-highlight + scroll target for `?focus=<request_id>` (notification deep link). */
  highlighted?: boolean;
  rowRef?: Ref<HTMLDivElement>;
  /** `departments.home_destination_id` for `row.departmentId` (REQ §13.93) — origin shows only when it differs. */
  homeDestinationId?: string | null;
  /**
   * `/my/history` renders the same card with no actions at all — a request whose day has
   * passed is read-only (REQ §13 item 91).
   */
  readOnly?: boolean;
  onWithdraw?: (row: DisplayRow) => void;
  onCancelRide?: (row: DisplayRow) => void;
  /** REQ §13.103 c: "קיצור הבקשה" on a multi-day request. */
  onShorten?: (row: DisplayRow) => void;
  onMakeRepeating?: (row: DisplayRow) => void;
  makeRepeatingPending?: boolean;
  onOptOutChange?: (row: DisplayRow, optOut: boolean) => void;
  /** REQ §13.101 h (QM8): the member's own active private cars in this department. */
  ownCars?: { id: string; name: string }[];
  onPlaceOnOwnCar?: (row: DisplayRow, carId: string) => void;
  /** REQ §13.101 e (QM4): "זו לא כפילות". */
  onRestoreDuplicate?: (row: DisplayRow) => void;
  actionPending?: boolean;
  /** REQ §13.108 f: "be back on time" note for this row (see `rowHandover()`); the parent fetches the neighbours once for all rows. */
  handover?: { notes: CarHandoverNotes; span: { startsAt: string; endsAt: string } } | null;
}

/** REQ §13.110 (b): "להגיע עד 09:30" / "יציאה מחיפה 13:00" when the member entered the times that way. */
function EnteredTimes({ labels }: { labels: EnteredTimeLabels }) {
  if (!labels.out && !labels.return) return null;
  return (
    <p className="text-xs text-muted-foreground" data-testid="request-entered-times">
      {[labels.out, labels.return].filter(Boolean).join(" · ")}
    </p>
  );
}

/**
 * One request/ride card + its row actions (edit / withdraw / cancel ride / make-repeating /
 * freed-slot opt-out), moved out of the now-deleted `RequestsListPage.tsx` so `/my` (Home) and
 * `/my/history` can share it (REQ §13 item 91, owner 2026-09-16, E3).
 */
export function RequestRow({
  row,
  highlighted,
  rowRef,
  homeDestinationId,
  readOnly,
  onWithdraw,
  onCancelRide,
  onShorten,
  onMakeRepeating,
  makeRepeatingPending,
  onOptOutChange,
  ownCars = [],
  onPlaceOnOwnCar,
  onRestoreDuplicate,
  actionPending,
  handover,
}: RequestRowProps) {
  return (
    <div
      ref={rowRef}
      data-request-id={row.id}
      className={cn("space-y-2 rounded-md border p-3 text-sm", highlighted && "ring-2 ring-primary")}
    >
      <div className="flex items-start justify-between gap-2">
        <TripSummary
          destination={originDestinationLabel(row, homeDestinationId)}
          purpose={row.rideTypeName}
          departAt={ownLegWindow(row).departAt}
          returnAt={ownLegWindow(row).returnAt}
        />
        <div className="flex shrink-0 items-center gap-2">
          {row.seriesLegs ? <Badge variant="outline">{tv("request.multiDayBadge", { count: String(row.seriesLegs.length) })}</Badge> : null}
          {row.status === "proposed" && row.acceptedAwaitingOthers
            ? <Badge variant="outline" data-testid="request-accepted-waiting">{he.request.acceptedWaitingOthers}</Badge>
            : <StatusBadge kind="request" status={displayStatus(row)} />}
        </div>
      </div>
      <EnteredTimes
        labels={enteredTimeLabels({
          departAnchor: row.departAnchor,
          arriveBy: row.arriveBy,
          returnAnchor: row.returnAnchor,
          leaveDestAt: row.leaveDestAt,
          destinationName: row.destination,
          isPickup: row.tripType === "drop_off",
        })}
      />
      <WindowSummaryLine row={{ durationLocked: row.durationLocked, departAt: row.departAt, returnAt: row.returnAt, flexReturnLate: row.flexReturnLate }} />
      <PlanBLines row={row} />
      {handover ? <CarHandoverNotice notes={handover.notes} ride={handover.span} /> : null}
      {row.ride?.needsDriver ? <p className="text-sm font-medium text-destructive">{he.rideCoordination.missingDriver}</p> : null}
      {row.tripType !== "round_trip" ? <p className="text-xs text-muted-foreground">{TRIP_TYPE_LABEL[row.tripType]}</p> : null}
      {row.hasLuggage ? <Badge variant="outline" className="w-fit" data-testid={row.luggageWaived ? "luggage-waived" : undefined}>{row.luggageWaived ? he.smallTrunk.waivedLabel : he.request.luggageChip}</Badge> : null}
      {row.preferredCarName ? <p className="text-xs text-muted-foreground">{he.request.preferredCar}: {row.preferredCarName}</p> : null}
      {row.childNames?.length ? (
        <p className="text-xs text-muted-foreground">{tv("ridePublicDetails.companions", { names: row.childNames.join(", ") })}</p>
      ) : null}
      {row.templateId ? (
        <p className="flex items-center gap-1 text-xs text-muted-foreground">
          <Repeat className="size-3.5" aria-hidden="true" />
          {he.request.repeating}
        </p>
      ) : null}
      {legStateLine(row) ? (
        <p className="text-xs font-medium" data-testid="request-leg-state">{legStateLine(row)}</p>
      ) : null}
      {knownStatusReason(row.statusReason) ? (
        <p className="text-xs text-muted-foreground">{knownStatusReason(row.statusReason)}</p>
      ) : null}
      {!readOnly && FREED_SLOT_ELIGIBLE_STATUSES.has(row.status) && onOptOutChange ? (
        <label className="flex items-center gap-2 text-xs text-muted-foreground">
          <input
            type="checkbox"
            className="size-4"
            checked={row.freedSlotOptOut}
            onChange={(e) => onOptOutChange(row, e.target.checked)}
          />
          {he.proposalScreen.optOutFreedSlots}
        </label>
      ) : null}
      {readOnly ? null : (
        <div className="flex flex-wrap gap-2 pt-1">
          {row.status === "proposed" && row.pendingProposal && isAwaitingAnswer(row.pendingProposal) ? (
            <OpenProposalButton proposalId={row.pendingProposal.id} size="sm" />
          ) : null}
          {row.statusReason === "WAITLISTED_CONTESTED" && (row.departAt ?? row.returnAt) ? (
            <OpenWaitlistGroupButton
              departmentId={row.departmentId}
              weekStart={row.weekStart}
              requestId={row.id}
              day={(row.departAt ?? row.returnAt) as string}
            />
          ) : null}
          {canEditRequest(row) && !row.seriesLegs ? (
            <Button asChild size="sm" variant="outline">
              <RequestLink to={paths.requests.edit(row.id)}>{he.requestsList.edit}</RequestLink>
            </Button>
          ) : null}
          {isDuplicateWithdrawn(row) && onRestoreDuplicate ? (
            <Button size="sm" variant="outline" disabled={actionPending} onClick={() => onRestoreDuplicate(row)}>
              {he.request.notDuplicate}
            </Button>
          ) : null}
          {onPlaceOnOwnCar && canPlaceOnOwnCar(row, ownCars.length)
            ? ownCars.map((car) => (
                <Button key={car.id} size="sm" variant="outline" disabled={actionPending} onClick={() => onPlaceOnOwnCar(row, car.id)}>
                  {ownCars.length > 1 ? `${he.request.placeOnOwnCar} (${car.name})` : he.request.placeOnOwnCar}
                </Button>
              ))
            : null}
          {row.status !== "withdrawn" && row.status !== "cancelled" && !row.ride && onWithdraw ? (
            <Button size="sm" variant="outline" onClick={() => onWithdraw(row)}>
              {he.requestsList.withdraw}
            </Button>
          ) : null}
          {row.seriesLegs && row.status !== "withdrawn" && row.status !== "cancelled" && onShorten ? (
            <Button size="sm" variant="outline" onClick={() => onShorten(row)}>
              {he.request.shortenSeries}
            </Button>
          ) : null}
          {row.ride && row.ride.status !== "cancelled" && onCancelRide ? (
            <Button size="sm" variant="outline" onClick={() => onCancelRide(row)}>
              {he.requestsList.cancelRide}
            </Button>
          ) : null}
          {!row.templateId && !row.seriesLegs && MAKE_REPEATING_STATUSES.has(row.status) && onMakeRepeating ? (
            <Button size="sm" variant="outline" disabled={makeRepeatingPending} onClick={() => onMakeRepeating(row)}>
              {he.request.makeRepeating}
            </Button>
          ) : null}
        </div>
      )}
    </div>
  );
}
