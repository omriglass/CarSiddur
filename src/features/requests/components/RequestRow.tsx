import { Repeat } from "lucide-react";
import type { Ref } from "react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { RideCard, type RideCardData } from "@/components/RideCard";
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
import { whoText } from "../whoLabel";
import { RequestLink } from "./RequestLink";
import { PlanBLines } from "./PlanBLines";
import { WindowSummaryLine } from "./WindowSummaryLine";
import { isKeepCarRow, keepCarTripLabel } from "../keepCar";
import { isAwaitingAnswer } from "../pendingProposal";
import { canPlaceOnOwnCar, isDuplicateWithdrawn } from "../overlap";
import { FREED_SLOT_ELIGIBLE_STATUSES, displayStatus, legStateLine, originDestinationLabel, ownLegWindow, type DisplayRow } from "../myRequestsRows";

const CANCEL_CLASS = "border-destructive/50 text-destructive hover:bg-destructive/10 hover:text-destructive";

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
  /** The signed-in member: tells a request filed for someone else (REQ §13.127 d) from the member's own. */
  viewerId?: string;
  onWithdraw?: (row: DisplayRow) => void;
  onCancelRide?: (row: DisplayRow) => void;
  /** REQ §13.103 c: "קיצור הבקשה" on a multi-day request. */
  onShorten?: (row: DisplayRow) => void;
  onOptOutChange?: (row: DisplayRow, optOut: boolean) => void;
  /** REQ §13.101 h (QM8): the member's own active private cars in this department. */
  ownCars?: { id: string; name: string }[];
  onPlaceOnOwnCar?: (row: DisplayRow, carId: string) => void;
  /** REQ §13.101 e (QM4): "זו לא כפילות". */
  onRestoreDuplicate?: (row: DisplayRow) => void;
  actionPending?: boolean;
  /** REQ §13.108 f: "be back on time" note for this row (see `rowHandover()`); the parent fetches the neighbours once for all rows. */
  handover?: { notes: CarHandoverNotes; span: { startsAt: string; endsAt: string } } | null;
  /**
   * `/my` one item per trip (owner 2026-10-13): the rides serving this request, shown as their ride cards
   * (car, driver, times, handover note) in place of the request's own summary line; a tap opens the ride.
   */
  rides?: RideCardData[];
  onOpenRide?: (rideId: string) => void;
}

/**
 * R10B5: the line "שובצת בתוכנית ב׳ …" already says the request is placed, so no "נשלחה" pill beside it while the member
 * has no outcome to show (the day is not published yet, REQ §13.109 a); once published the ordinary outcome pill shows.
 */
function planBServedWithoutOutcome(row: DisplayRow): boolean {
  return !!row.servedByAlternative && !!row.alternative && displayStatus(row) === "submitted";
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
  viewerId,
  onWithdraw,
  onCancelRide,
  onShorten,
  onOptOutChange,
  ownCars = [],
  onPlaceOnOwnCar,
  onRestoreDuplicate,
  actionPending,
  handover,
  rides,
  onOpenRide,
}: RequestRowProps) {
  // R11U2: every other person on the request — member companions, named children, guests, then the unnamed counts.
  const others = whoText([...(row.companionNames ?? []), ...(row.childNames ?? []), ...(row.guestNames ?? [])], row.extraAdults ?? 0, row.unnamedChildren ?? 0);
  // REQ §13.127 (d): who filed it / who it is for. Repeating, duplicate restore, freed-slot opt-out and
  // cancelling the ride stay with the requester (the server refuses them for the filer).
  const filedByOther = !!viewerId && !!row.filedById && !!row.requesterId && row.filedById !== row.requesterId;
  const iAmRequester = !!viewerId && row.requesterId === viewerId;
  const notRequester = !!viewerId && !!row.requesterId && row.requesterId !== viewerId;
  const filedLine = filedByOther && iAmRequester && row.filerName
    ? tv("request.filedBy", { name: row.filerName })
    : filedByOther && row.filedById === viewerId && notRequester && row.requesterName
      ? tv("request.filedFor", { name: row.requesterName })
      : null;
  // Owner 2026-10-13: one red "ביטול" — removes a request with no ride yet (`onWithdraw`), cancels its ride once placed
  // (`onCancelRide`, the requester's own); each keeps its own confirmation dialog. "Repeat weekly" lives in the edit form.
  const cancelAction = row.companionOf ? null : row.ride && row.ride.status !== "cancelled"
    ? (onCancelRide && !notRequester ? () => onCancelRide(row) : null)
    : row.status !== "withdrawn" && row.status !== "cancelled" && onWithdraw ? () => onWithdraw(row) : null;
  const badges = (
    <>
      {row.seriesLegs ? <Badge variant="outline">{tv("request.multiDayBadge", { count: String(row.seriesLegs.length) })}</Badge> : null}
      {row.status === "proposed" && row.acceptedAwaitingOthers
        ? <Badge variant="outline" data-testid="request-accepted-waiting">{he.request.acceptedWaitingOthers}</Badge>
        : planBServedWithoutOutcome(row) ? null : <StatusBadge kind="request" status={displayStatus(row)} />}
    </>
  );
  return (
    <div
      ref={rowRef}
      data-request-id={row.id}
      className={cn("space-y-2 rounded-md border p-3 text-sm", highlighted && "ring-2 ring-primary")}
    >
      {rides?.length ? (
        <>
          <div className="flex items-center justify-end gap-2">{badges}</div>
          {rides.map((ride) => (
            <RideCard key={ride.id} ride={ride} onClick={onOpenRide ? () => onOpenRide(ride.id) : undefined} />
          ))}
        </>
      ) : (
        <div className="flex items-start justify-between gap-2">
          <TripSummary
            destination={originDestinationLabel(row, homeDestinationId)}
            purpose={row.rideTypeName}
            departAt={ownLegWindow(row).departAt}
            returnAt={ownLegWindow(row).returnAt}
          />
          <div className="flex shrink-0 items-center gap-2">{badges}</div>
        </div>
      )}
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
      {handover && !rides?.length ? <CarHandoverNotice notes={handover.notes} ride={handover.span} /> : null}
      {row.ride?.needsDriver && !rides?.length ? <p className="text-sm font-medium text-destructive">{he.rideCoordination.missingDriver}</p> : null}
      {isKeepCarRow(row) ? (
        <p className="text-xs text-muted-foreground" data-testid="keep-car-note">{keepCarTripLabel(row.destination)}</p>
      ) : row.tripType !== "round_trip" ? <p className="text-xs text-muted-foreground">{TRIP_TYPE_LABEL[row.tripType]}</p> : null}
      {row.hasLuggage ? <Badge variant="outline" className="w-fit" data-testid={row.luggageWaived ? "luggage-waived" : undefined}>{row.luggageWaived ? he.smallTrunk.waivedLabel : he.request.luggageChip}</Badge> : null}
      {row.preferredCarName ? <p className="text-xs text-muted-foreground">{he.request.preferredCar}: {row.preferredCarName}</p> : null}
      {filedLine ? <p className="text-xs text-muted-foreground" data-testid="request-filed-line"><bdi>{filedLine}</bdi></p> : null}
      {row.companionOf ? <p className="text-xs text-muted-foreground" data-testid="request-companion-line"><bdi>{tv("request.companionAddedBy", { name: row.companionOf })}</bdi></p> : null}
      {others ? (
        <p className="text-xs text-muted-foreground" data-testid="request-other-people">{tv("ridePublicDetails.companions", { names: others })}</p>
      ) : null}
      {row.rideDescription ? <p className="text-xs text-muted-foreground" data-testid="request-description"><bdi>{row.rideDescription}</bdi></p> : null}
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
      {!readOnly && !notRequester && !row.servedByAlternative && FREED_SLOT_ELIGIBLE_STATUSES.has(row.status) && onOptOutChange ? (
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
          {/* Owner 2026-10-22 (REQ §13.142): a multi-day request is edited too — over its whole span. */}
          {canEditRequest(row) ? (
            <Button asChild size="sm" variant="outline">
              <RequestLink to={paths.requests.edit(row.id)}>{he.requestsList.edit}</RequestLink>
            </Button>
          ) : null}
          {isDuplicateWithdrawn(row) && onRestoreDuplicate && !notRequester ? (
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
          {row.seriesLegs && row.status !== "withdrawn" && row.status !== "cancelled" && onShorten ? (
            <Button size="sm" variant="outline" onClick={() => onShorten(row)}>
              {he.request.shortenSeries}
            </Button>
          ) : null}
          {cancelAction ? (
            <Button size="sm" variant="outline" className={CANCEL_CLASS} onClick={cancelAction}>
              {he.requestsList.cancel}
            </Button>
          ) : null}
        </div>
      )}
    </div>
  );
}
