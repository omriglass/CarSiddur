import { ConfirmDialog } from "@/components/ConfirmDialog";
import { Button } from "@/components/ui/button";
import { he } from "@/i18n/he";

import type { FreedCarGate } from "./useFreedCar";

/** "הרכב יתפנה לאחרים" — the line, "לשמור" / "לשמור בלי להעביר את הרכב" (REQ item 237) / "חזרה". */
export function FreedCarConfirmDialog({ dialog, loading = false }: { dialog: FreedCarGate["dialog"]; loading?: boolean }) {
  return (
    <ConfirmDialog
      open={dialog.open}
      onOpenChange={(open) => { if (!open) dialog.onBack(); }}
      title={he.freedCar.confirmTitle}
      description={dialog.line}
      confirmLabel={he.freedCar.confirmSave}
      cancelLabel={he.freedCar.confirmBack}
      loading={loading}
      onConfirm={dialog.onConfirm}
    >
      <KeepOutButton label={he.freedCar.keepOutSave} disabled={loading} onClick={dialog.onKeepOut} />
    </ConfirmDialog>
  );
}

/** The third answer of a freed-car prompt: do it, but offer the freed hours to nobody waiting (REQ item 237). */
export function KeepOutButton({ label, disabled = false, onClick }: { label: string; disabled?: boolean; onClick: () => void }) {
  return (
    <Button type="button" variant="outline" className="h-auto min-h-11 w-full whitespace-normal" disabled={disabled} onClick={onClick} data-testid="freed-car-keep-out">
      {label}
    </Button>
  );
}
