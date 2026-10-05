import { Repeat } from "lucide-react";
import type { Ref } from "react";
import { Link } from "react-router-dom";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { StatusBadge } from "@/components/StatusBadge";
import { TripSummary } from "@/components/TripSummary";
import { OpenProposalButton } from "@/features/proposals/components/OpenProposalButton";
import { OpenWaitlistGroupButton } from "@/features/waitlist/components/OpenWaitlistGroupButton";
import { he, tv } from "@/i18n/he";
import { describeStatusReason } from "@/lib/statusReason";
import { cn } from "@/lib/utils";
import { paths } from "@/app/routes";

import type { TripType } from "@/lib/enums";

import { canEditRequest } from "../window";
import { FREED_SLOT_ELIGIBLE_STATUSES, MAKE_REPEATING_STATUSES, originDestinationLabel, type DisplayRow } from "../myRequestsRows";

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
  onMakeRepeating?: (row: DisplayRow) => void;
  makeRepeatingPending?: boolean;
  onOptOutChange?: (row: DisplayRow, optOut: boolean) => void;
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
  onMakeRepeating,
  makeRepeatingPending,
  onOptOutChange,
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
          departAt={row.ride?.startsAt ?? row.departAt}
          returnAt={row.ride?.endsAt ?? row.returnAt}
        />
        <div className="flex shrink-0 items-center gap-2">
          {row.seriesLegs ? <Badge variant="outline">{tv("request.multiDayBadge", { count: String(row.seriesLegs.length) })}</Badge> : null}
          <StatusBadge kind="request" status={row.status} />
        </div>
      </div>
      {row.ride?.needsDriver ? <p className="text-sm font-medium text-destructive">{he.rideCoordination.missingDriver}</p> : null}
      {row.tripType !== "round_trip" ? <p className="text-xs text-muted-foreground">{TRIP_TYPE_LABEL[row.tripType]}</p> : null}
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
      {describeStatusReason(row.statusReason) ? (
        <p className="text-xs text-muted-foreground">{describeStatusReason(row.statusReason)}</p>
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
          {row.status === "proposed" && row.pendingProposal ? (
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
              <Link to={paths.requests.edit(row.id)}>{he.requestsList.edit}</Link>
            </Button>
          ) : null}
          {row.status !== "withdrawn" && row.status !== "cancelled" && !row.ride && onWithdraw ? (
            <Button size="sm" variant="outline" onClick={() => onWithdraw(row)}>
              {he.requestsList.withdraw}
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
