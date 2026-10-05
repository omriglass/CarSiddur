// REQ §13.94: every board popup that leads to the proposal composer (drag beyond flexibility,
// suggestion "הצע", ride-sheet save beyond flexibility, "הצעת זמנים"/"פתרון חיצוני") first offers
// "טיוטה" next to "הכן הצעה". One dialog, so a new call site gets the choice for free.
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { he } from "@/i18n/he";

import type { ComposerPrefill } from "../draftInput";

export interface DraftChoiceDialogProps {
  choice: ComposerPrefill | null;
  requesterName: string | null | undefined;
  onCompose: () => void;
  onDraft: () => void;
  busy?: boolean;
  onCancel: () => void;
}

export function DraftChoiceDialog({ choice, requesterName, onCompose, onDraft, busy, onCancel }: DraftChoiceDialogProps) {
  return (
    <Dialog open={!!choice} onOpenChange={(open) => !open && onCancel()}>
      <DialogContent data-testid="draft-choice-dialog">
        <DialogHeader>
          <DialogTitle>{he.boardDrafts.chooserTitle}</DialogTitle>
          <DialogDescription>{he.boardDrafts.chooserHelp}</DialogDescription>
        </DialogHeader>
        {choice ? (
          <p className="rounded-md border p-3 text-sm">
            {requesterName ?? ""} · {he.proposal.type[choice.type]}
          </p>
        ) : null}
        <Button onClick={onCompose} disabled={busy} data-testid="draft-choice-compose">{he.boardDrafts.prepare}</Button>
        <Button variant="secondary" onClick={onDraft} disabled={busy} data-testid="draft-choice-draft">{he.boardDrafts.draftButton}</Button>
        <Button variant="outline" onClick={onCancel}>{he.common.cancel}</Button>
      </DialogContent>
    </Dialog>
  );
}
