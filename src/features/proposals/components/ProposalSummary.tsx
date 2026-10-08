import { StatusBadge } from "@/components/StatusBadge";
import { TripSummary } from "@/components/TripSummary";
import { he, tv } from "@/i18n/he";
import { formatTime } from "@/lib/time";

import type { ProposalStatus, ProposalType } from "@/lib/enums";

interface ProposalSummaryProps {
  /** Omit to show only the trip line (e.g. an editable type selector already renders it elsewhere). */
  type?: ProposalType;
  status?: ProposalStatus;
  requesterName?: string | null;
  destination?: string | null;
  purpose?: string | null;
  departAt: string | null;
  returnAt: string | null;
  /** Merge proposals only — the ride the request would join. */
  hostDriverName?: string | null;
  /** `origin` proposals only — resolved place/car names for the one-line "יציאה מ... במקום מ..." summary. */
  originChange?: { from: string | null; to: string | null; car?: string | null } | null;
  /** `alternative` proposals only (REQ §13.112 a) -- the member's own plan B: "הקפצה ל… עד … ואיסוף משם ב…" (the main information of the proposal, so normal size - R10U3). */
  alternative?: { dropPlace: string; arriveBy: string; pickupAt: string | null; pickupPlace?: string } | null;
}

/**
 * One source of truth for how a proposal reads: used by the Sadran's
 * proposals list row, the `/p/:token` answer screen header and the board's
 * proposal composer (UX_FLOWS.md §4.3, §3.6). Never shows raw ids — a
 * requester's name, destination, day/time and (for merges) the host
 * driver's name only.
 */
export function ProposalSummary({
  type,
  status,
  requesterName,
  destination,
  purpose,
  departAt,
  returnAt,
  hostDriverName,
  originChange,
  alternative,
}: ProposalSummaryProps) {
  return (
    <div className="space-y-1">
      {type || status ? (
        <div className="flex flex-wrap items-center gap-2 text-sm font-medium">
          {type ? <span>{he.proposal.type[type]}</span> : null}
          {status ? <StatusBadge kind="proposal" status={status} /> : null}
        </div>
      ) : null}
      <TripSummary name={requesterName} destination={destination} purpose={purpose} departAt={departAt} returnAt={returnAt} />
      {hostDriverName ? (
        <p className="text-xs text-muted-foreground">{tv("sadranProposal.hostDriverLabel", { name: hostDriverName })}</p>
      ) : null}
      {alternative ? (
        <p className="text-base font-medium text-foreground" data-testid="proposal-alternative">
          {tv("sadranProposal.alternativePlan", {
            dropPlace: alternative.dropPlace,
            dropTime: formatTime(new Date(alternative.arriveBy)),
            pickupLine: alternative.pickupAt
              ? tv(alternative.pickupPlace ? "sadranProposal.alternativePickupFrom" : "sadranProposal.alternativePickup", { pickupTime: formatTime(new Date(alternative.pickupAt)), pickupPlace: alternative.pickupPlace ?? "" })
              : "",
          })}
        </p>
      ) : null}
      {originChange?.to ? (
        <p className="text-xs text-muted-foreground">
          {tv("rideCoordination.originChangeSummary", { from: originChange.from ?? "", to: originChange.to, car: originChange.car ?? "" })}
        </p>
      ) : null}
    </div>
  );
}
