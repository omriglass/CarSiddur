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

import type { ProposalRow } from "../../api";

export interface ProposalActionSheetProps {
  proposal: ProposalRow | null;
  requesterName: string | null | undefined;
  /** ISO instant of the proposal's day (the request's day). */
  dayIso: string | null | undefined;
  busy?: boolean;
  onOpenChange: (open: boolean) => void;
  onSend: (proposal: ProposalRow) => void;
  onEdit: (proposal: ProposalRow) => void;
  onDiscard: (proposal: ProposalRow) => void;
  onWithdraw: (proposal: ProposalRow) => void;
}

export function ProposalActionSheet({ proposal, requesterName, dayIso, busy, onOpenChange, onSend, onEdit, onDiscard, onWithdraw }: ProposalActionSheetProps) {
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
