// REQ §13.138 (a): every board change that needs a member's consent (drag beyond flexibility, suggestion "הצע",
// ride-sheet save beyond flexibility, "הצעת זמנים"/"פתרון חיצוני", plan B, fewer days) first asks "דיברת עם X על
// השינוי?": "כן, כבר סיכמנו" (applied now, no proposal), "צריך לדבר — אני עוד עובד/ת על הטיוטה" (a board draft, sent
// later with "שלח את כל ההצעות") or "צריך לדבר — שלח עכשיו" (the composer). One dialog, so a new call site gets the
// question for free. The merge popup (`MergePrefillDialog`) carries the same three answers.
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { he } from "@/i18n/he";

import { talkedTitle } from "../talkedTitle";

import type { ComposerPrefill } from "../draftInput";

export interface DraftChoiceDialogProps {
  choice: ComposerPrefill | null;
  /** The people the change needs (the requester; for a merge also the ride's people). */
  partyNames: readonly string[];
  onAgree: () => void;
  onCompose: () => void;
  onDraft: () => void;
  busy?: boolean;
  onCancel: () => void;
}

export function DraftChoiceDialog({ choice, partyNames, onAgree, onCompose, onDraft, busy, onCancel }: DraftChoiceDialogProps) {
  return (
    <Dialog open={!!choice} onOpenChange={(open) => !open && onCancel()}>
      <DialogContent data-testid="draft-choice-dialog">
        <DialogHeader>
          <DialogTitle>{talkedTitle(partyNames)}</DialogTitle>
          <DialogDescription>{he.boardDrafts.talkedHelp}</DialogDescription>
        </DialogHeader>
        {choice ? (
          <p className="rounded-md border p-3 text-sm">
            {partyNames[0] ?? ""} · {he.proposal.type[choice.type]}
          </p>
        ) : null}
        <Button onClick={onAgree} disabled={busy} className="min-h-11" data-testid="draft-choice-agreed">{he.boardDrafts.talkedYes}</Button>
        <Button variant="secondary" onClick={onDraft} disabled={busy} className="min-h-11 whitespace-normal" data-testid="draft-choice-draft">{he.boardDrafts.talkedDraft}</Button>
        <Button variant="secondary" onClick={onCompose} disabled={busy} className="min-h-11 whitespace-normal" data-testid="draft-choice-compose">{he.boardDrafts.talkedSendNow}</Button>
        <Button variant="outline" onClick={onCancel}>{he.common.cancel}</Button>
      </DialogContent>
    </Dialog>
  );
}
