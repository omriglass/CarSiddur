import { Inbox } from "lucide-react";
import { useState } from "react";
import { useNavigate } from "react-router-dom";

import { EmptyState } from "@/components/EmptyState";
import { PageHeader } from "@/components/PageHeader";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { StatusBadge } from "@/components/StatusBadge";
import { he, t, tv } from "@/i18n/he";
import { formatTime } from "@/lib/time";

import { useProposalsForWeek, useWeekRequests } from "../../hooks";

import type { Database } from "@/integrations/supabase/types";

type ProposalType = Database["public"]["Enums"]["proposal_type"];

interface ProposalsListScreenProps {
  departmentId: string;
  weekStart: string;
}

/** `/sadran/:dept/:week/proposals` — proposals list + manual composer entry (UX_FLOWS.md §4.3, "from a suggestion or manual"). */
export function ProposalsListScreen({ departmentId, weekStart }: ProposalsListScreenProps) {
  const navigate = useNavigate();
  const proposalsQuery = useProposalsForWeek(departmentId, weekStart);
  const requestsQuery = useWeekRequests(departmentId, weekStart);

  const proposals = proposalsQuery.data ?? [];
  // `proposals_one_sent_per_request_idx` (supabase/migrations/20260907090900_proposals.sql)
  // allows only one `sent` proposal per request at a time — excluding those
  // here (rather than only in `create_proposal`'s error path) also keeps a
  // Sadran from starting a second, doomed-to-conflict proposal in the first place.
  const requestIdsWithSentProposal = new Set(proposals.filter((p) => p.status === "sent").map((p) => p.request_id));
  const eligibleRequests = (requestsQuery.data ?? []).filter(
    (r) => r.status !== "draft" && r.status !== "withdrawn" && r.status !== "cancelled" && !requestIdsWithSentProposal.has(r.id),
  );

  const [manualRequestId, setManualRequestId] = useState("");
  const [manualType, setManualType] = useState<ProposalType>("shift");

  return (
    <div className="mx-auto max-w-3xl space-y-3 p-4 pb-24">
      <PageHeader title={he.screen.proposals.title} />

      <Card>
        <CardContent className="flex flex-wrap items-center gap-2 p-3">
          <span className="text-sm font-medium">{he.screen.proposal.compose}</span>
          <Select value={manualRequestId} onValueChange={setManualRequestId}>
            <SelectTrigger className="w-48">
              <SelectValue placeholder={he.field.destination} />
            </SelectTrigger>
            <SelectContent>
              {eligibleRequests.map((r) => (
                <SelectItem key={r.id} value={r.id}>
                  {r.destination_text ?? r.id.slice(0, 8)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Select value={manualType} onValueChange={(v) => setManualType(v as ProposalType)}>
            <SelectTrigger className="w-36">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {/* "merge" is deliberately not offered manually here — it needs a
                  host ride (`payload.ride_id`/`legs`, `proposals_payload_shape_ck`),
                  which only the board's merge-by-drag / suggestion actions supply
                  (BoardScreen.tsx `goToComposer`); see the stage 2b report. */}
              <SelectItem value="shift">{he.proposal.type.shift}</SelectItem>
              <SelectItem value="deny">{he.proposal.type.deny}</SelectItem>
              <SelectItem value="external">{he.proposal.type.external}</SelectItem>
            </SelectContent>
          </Select>
          <Button
            disabled={!manualRequestId}
            onClick={() =>
              navigate(`/sadran/${departmentId}/${weekStart}/proposals/new`, {
                state: { requestId: manualRequestId, rideId: null, type: manualType, payload: {} },
              })
            }
          >
            {t("action.propose")}
          </Button>
        </CardContent>
      </Card>

      {proposals.length === 0 ? (
        <EmptyState icon={Inbox} message={he.sadranProposal.listNone} />
      ) : (
        <div className="space-y-2">
          {proposals.map((p) => {
            const request = (requestsQuery.data ?? []).find((r) => r.id === p.request_id);
            return (
              <Card
                key={p.id}
                className="cursor-pointer"
                onClick={() => navigate(`/sadran/${departmentId}/${weekStart}/proposals/new`, {
                  // `proposalId` (Stage 3 hardening fix, UX_FLOWS.md §16 item 9): shows this
                  // proposal's actual current status instead of an empty "compose new" form.
                  state: { requestId: p.request_id, rideId: p.ride_id, type: p.type, payload: p.payload ?? {}, proposalId: p.id },
                })}
              >
                <CardContent className="flex items-center justify-between gap-2 p-3 text-sm">
                  <div>
                    <div className="font-medium">
                      {he.proposal.type[p.type as "shift" | "merge" | "deny" | "external"] ?? p.type}
                      {" · "}
                      {request?.destination_text ?? ""}
                    </div>
                    <div className="text-xs text-muted-foreground">
                      {request?.depart_at ? formatTime(new Date(request.depart_at)) : ""} ·{" "}
                      {tv("sadranProposal.expiresAtLabel", { when: formatTime(new Date(p.expires_at)) })}
                    </div>
                  </div>
                  <StatusBadge kind="proposal" status={p.status} />
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}
    </div>
  );
}
