import { Inbox } from "lucide-react";
import { useEffect, useRef } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";

import { paths } from "@/app/routes";
import { EmptyState } from "@/components/EmptyState";
import { PageHeader } from "@/components/PageHeader";
import { Card, CardContent } from "@/components/ui/card";
import { ProposalSummary } from "@/features/proposals/components/ProposalSummary";
import { he, tv } from "@/i18n/he";
import { formatTime } from "@/lib/time";
import { cn } from "@/lib/utils";

import { useAllWeekRides, useProposalsForWeek, useWeekRequestsWithNames } from "../../hooks";

interface ProposalsListScreenProps {
  departmentId: string;
  weekStart: string;
}

/**
 * `/sadran/:dept/:week/proposals` — proposals list (UX_FLOWS.md §4.3). New
 * proposals are only ever created from the board (dragging a request onto a
 * ride, or a suggestion action) — this screen is read/answer-status only;
 * see `he.sadranProposal.composeFromBoardHint`.
 */
export function ProposalsListScreen({ departmentId, weekStart }: ProposalsListScreenProps) {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const highlightedId = searchParams.get("proposal");
  const returnTo = paths.sadran.proposals(departmentId, weekStart);
  const boardPath = paths.sadran.board(departmentId, weekStart);

  const proposalsQuery = useProposalsForWeek(departmentId, weekStart);
  const requestsQuery = useWeekRequestsWithNames(departmentId, weekStart);
  const ridesQuery = useAllWeekRides(departmentId, weekStart);

  const proposals = proposalsQuery.data ?? [];
  const requests = requestsQuery.data ?? [];
  const rides = ridesQuery.data ?? [];

  const highlightedRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (highlightedId) highlightedRef.current?.scrollIntoView({ behavior: "smooth", block: "center" });
  }, [highlightedId]);

  return (
    <div className="mx-auto max-w-3xl space-y-3 p-4 pb-24">
      <PageHeader title={he.screen.proposals.title} />

      <Card>
        <CardContent className="flex flex-wrap items-center justify-between gap-2 p-3 text-sm">
          <span className="text-muted-foreground">{he.sadranProposal.composeFromBoardHint}</span>
          <Link to={boardPath} className="font-medium text-primary underline underline-offset-2">
            {he.sadranProposal.goToBoard}
          </Link>
        </CardContent>
      </Card>

      {proposals.length === 0 ? (
        <EmptyState icon={Inbox} message={he.sadranProposal.listNone} />
      ) : (
        <div className="space-y-2">
          {proposals.map((p) => {
            const request = requests.find((r) => r.id === p.request_id);
            const hostRide = p.type === "merge" && p.ride_id ? rides.find((r) => r.id === p.ride_id) : undefined;
            const isHighlighted = highlightedId === p.id;
            return (
              <Card
                key={p.id}
                ref={isHighlighted ? highlightedRef : undefined}
                data-testid="proposal-row"
                data-proposal-id={p.id}
                className={cn("cursor-pointer", isHighlighted && "ring-2 ring-primary")}
                onClick={() =>
                  navigate(paths.sadran.composer(departmentId, weekStart), {
                    // `proposalId` (Stage 3 hardening fix, UX_FLOWS.md §16 item 9): shows this
                    // proposal's actual current status instead of an empty "compose new" form.
                    state: { returnTo, requestId: p.request_id, rideId: p.ride_id, type: p.type, payload: p.payload ?? {}, proposalId: p.id },
                  })
                }
              >
                <CardContent className="flex items-center justify-between gap-2 p-3 text-sm">
                  <ProposalSummary
                    type={p.type}
                    status={p.status}
                    requesterName={request?.requester_full_name}
                    destination={request?.destination_resolved_name ?? request?.destination_text}
                    purpose={request?.ride_type_name_he}
                    departAt={request?.depart_at ?? null}
                    returnAt={request?.return_at ?? null}
                    hostDriverName={hostRide?.driver_name}
                  />
                  {p.expires_at ? (
                    <span className="whitespace-nowrap text-xs text-muted-foreground" dir="ltr">
                      {tv("sadranProposal.expiresAtLabel", { when: formatTime(new Date(p.expires_at)) })}
                    </span>
                  ) : null}
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}
    </div>
  );
}
