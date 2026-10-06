// REQ §13.94: tapping a draft block (or a sent/accepted merge ghost) on the board opens this
// small sheet. Draft: שלח (composer on that draft, whose send is `send_proposal`), ערוך
// (composer, editable), מחק טיוטה (`discard_proposal`). Sent/accepted: open it (composer view)
// or בטל הצעה (`withdraw_proposal`, no message to the member).
import { useState } from "react";

import { ConfirmDialog } from "@/components/ConfirmDialog";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { he, tv } from "@/i18n/he";
import { formatDayDate } from "@/lib/dayLabels";

import { useMergePreview } from "../../hooks";
import { mergePayloadLeg } from "../mergeProposal";
import { proposalChangeLines } from "../proposalChange";

import type { ProposalRow, WeekRequestRow } from "../../api";

/** R5U1: what the sheet needs to state old -> new (the request, the car it rides now, the car the proposal names). */
export interface ProposalChangeContext {
  request: Pick<WeekRequestRow, "depart_at" | "return_at" | "trip_shape"> | undefined;
  oldCarName?: string | null;
  newCarName?: string | null;
}

function ProposalChanges({ proposal, context }: { proposal: ProposalRow; context: ProposalChangeContext }) {
  const payload = proposal.payload && typeof proposal.payload === "object" && !Array.isArray(proposal.payload) ? (proposal.payload as Record<string, unknown>) : {};
  const isMerge = proposal.type === "merge";
  const leg = context.request ? mergePayloadLeg(payload, context.request) : "out";
  const server = useMergePreview(proposal.ride_id, proposal.request_id, leg, isMerge && !!proposal.ride_id && !!context.request);
  const lines = proposalChangeLines({ type: proposal.type, payload, request: context.request, oldCarName: context.oldCarName, newCarName: context.newCarName, server: server.data });
  if (!lines.length) return null;
  return (
    <div className="space-y-1 rounded-md border p-3 text-sm" data-testid="proposal-changes">
      <p className="text-xs font-medium text-muted-foreground">{he.boardDrafts.changesTitle}</p>
      {lines.map((line) => <p key={line}>{line}</p>)}
    </div>
  );
}

export interface ProposalActionSheetProps {
  proposal: ProposalRow | null;
  requesterName: string | null | undefined;
  /** ISO instant of the proposal's day (the request's day). */
  dayIso: string | null | undefined;
  /** R5U1: old -> new times and car (shift / merge). */
  changes?: ProposalChangeContext;
  busy?: boolean;
  onOpenChange: (open: boolean) => void;
  onSend: (proposal: ProposalRow) => void;
  onEdit: (proposal: ProposalRow) => void;
  onDiscard: (proposal: ProposalRow) => void;
  onWithdraw: (proposal: ProposalRow) => void;
}

export function ProposalActionSheet({ proposal, requesterName, dayIso, changes, busy, onOpenChange, onSend, onEdit, onDiscard, onWithdraw }: ProposalActionSheetProps) {
  const [confirmWithdraw, setConfirmWithdraw] = useState(false);
  const isDraft = proposal?.status === "draft";
  const withdrawable = proposal?.status === "sent" || proposal?.status === "accepted";
  return (
    <>
      <Sheet open={!!proposal} onOpenChange={onOpenChange}>
        <SheetContent side="bottom" data-testid="proposal-action-sheet">
          <SheetHeader>
            <SheetTitle>{isDraft ? he.boardDrafts.sheetTitle : he.boardDrafts.sentSheetTitle}</SheetTitle>
            <SheetDescription>
              {proposal ? tv("boardDrafts.sheetSummary", {
                name: requesterName ?? "",
                type: he.proposal.type[proposal.type],
                day: dayIso ? formatDayDate(dayIso) : "",
              }) : ""}
            </SheetDescription>
          </SheetHeader>
          {proposal && changes ? <ProposalChanges proposal={proposal} context={changes} /> : null}
          {proposal ? (
            <div className="flex flex-wrap gap-2 py-3">
              {isDraft ? (
                <>
                  <Button disabled={busy} onClick={() => onSend(proposal)} data-testid="draft-send">{he.boardDrafts.send}</Button>
                  <Button variant="outline" disabled={busy} onClick={() => onEdit(proposal)} data-testid="draft-edit">{he.boardDrafts.edit}</Button>
                  <Button variant="destructive" disabled={busy} onClick={() => onDiscard(proposal)} data-testid="draft-discard">{he.boardDrafts.discard}</Button>
                </>
              ) : (
                <>
                  <Button variant="outline" disabled={busy} onClick={() => onSend(proposal)}>{he.sadranProposal.openSentProposal}</Button>
                  {withdrawable ? (
                    <Button variant="destructive" disabled={busy} onClick={() => setConfirmWithdraw(true)} data-testid="proposal-withdraw">{he.boardDrafts.withdraw}</Button>
                  ) : null}
                </>
              )}
              <Button variant="ghost" onClick={() => onOpenChange(false)}>{he.boardDrafts.close}</Button>
            </div>
          ) : null}
        </SheetContent>
      </Sheet>
      <ConfirmDialog
        open={confirmWithdraw}
        onOpenChange={setConfirmWithdraw}
        title={he.boardDrafts.withdrawConfirmTitle}
        description={he.boardDrafts.withdrawConfirmBody}
        confirmLabel={he.boardDrafts.withdraw}
        destructive
        loading={busy}
        onConfirm={() => { setConfirmWithdraw(false); if (proposal) onWithdraw(proposal); }}
      />
    </>
  );
}
