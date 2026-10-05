// Extracted from `BoardScreen.tsx` (docs/TODO.md "Code review 2026-09-24" R9):
// the confirmation dialog shown before handing a drag-created merge over to
// the proposal composer. Pure move — behaviour and markup unchanged.
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { he } from "@/i18n/he";
import { formatTime } from "@/lib/time";

export interface MergePrefill {
  requestId: string;
  rideId: string | null;
  type: "shift" | "merge" | "deny" | "external" | "origin";
  payload: Record<string, unknown>;
  proposalId?: string;
}

export interface MergePrefillDialogProps {
  prefill: MergePrefill | null;
  hostLabel: string | null | undefined;
  requesterName: string | null | undefined;
  destinationName: string | null | undefined;
  onConfirm: () => void;
  onCancel: () => void;
}

export function MergePrefillDialog({ prefill, hostLabel, requesterName, destinationName, onConfirm, onCancel }: MergePrefillDialogProps) {
  return (
    <Dialog open={!!prefill} onOpenChange={(open) => !open && onCancel()}>
      <DialogContent><DialogHeader><DialogTitle>{he.boardCoordination.mergeTitle}</DialogTitle><DialogDescription>{he.boardCoordination.mergeHelp}</DialogDescription></DialogHeader>
        {prefill ? <div className="space-y-2 rounded-md border p-3 text-sm">
          <p>{hostLabel}</p>
          <p>{requesterName} · {destinationName}</p>
          {typeof prefill.payload.starts_at === "string" && typeof prefill.payload.ends_at === "string" ? <p>{he.boardCoordination.expandedWindow} · <strong dir="ltr">{formatTime(new Date(prefill.payload.starts_at))}–{formatTime(new Date(prefill.payload.ends_at))}</strong></p> : null}
        </div> : null}
        <Button onClick={onConfirm}>{he.sadranBoard.prepareMerge}</Button>
        <Button variant="outline" onClick={onCancel}>{he.common.cancel}</Button>
      </DialogContent>
    </Dialog>
  );
}
