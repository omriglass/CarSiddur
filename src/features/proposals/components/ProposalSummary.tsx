import { StatusBadge } from "@/components/StatusBadge";
import { TripSummary } from "@/components/TripSummary";
import { he, tv } from "@/i18n/he";

import type { Database } from "@/integrations/supabase/types";

type ProposalType = Database["public"]["Enums"]["proposal_type"];
type ProposalStatus = Database["public"]["Enums"]["proposal_status"];

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
    </div>
  );
}
