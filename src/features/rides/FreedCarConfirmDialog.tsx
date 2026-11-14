import { ConfirmDialog } from "@/components/ConfirmDialog";
import { he } from "@/i18n/he";

import type { FreedCarGate } from "./useFreedCar";

/** "הרכב יתפנה לאחרים" — the line, "לשמור" / "חזרה". */
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
    />
  );
}
