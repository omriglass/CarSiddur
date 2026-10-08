import { useCallback, useState } from "react";
import type { ReactNode } from "react";

import { ConfirmDialog } from "@/components/ConfirmDialog";
import { he } from "@/i18n/he";
import { smallTrunkConfirmBody } from "@/lib/smallTrunk";
import type { SmallTrunkInfo } from "@/lib/smallTrunk";

interface Pending {
  info: SmallTrunkInfo;
  resolve: (accepted: boolean) => void;
}

/**
 * REQ §13.111 (a): the state behind the one "צריך תא מטען גדול ... לשבץ בכל זאת?" dialog.
 * `ask(info)` shows it and resolves `true` on "לשבץ בכל זאת", `false` on cancel/close. Only
 * `SmallTrunkHost` uses this directly; everything else goes through `lib/smallTrunk.ts`.
 */
export function useSmallTrunkConfirm(): { ask: (info: SmallTrunkInfo) => Promise<boolean>; dialog: ReactNode } {
  const [pending, setPending] = useState<Pending | null>(null);
  const ask = useCallback(
    (info: SmallTrunkInfo) => new Promise<boolean>((resolve) => { setPending({ info, resolve }); }),
    [],
  );
  const settle = (accepted: boolean) => {
    pending?.resolve(accepted);
    setPending(null);
  };
  const dialog = pending ? (
    <ConfirmDialog
      open
      onOpenChange={(open) => { if (!open) settle(false); }}
      title={he.smallTrunk.confirmTitle}
      description={smallTrunkConfirmBody(pending.info)}
      confirmLabel={he.smallTrunk.confirmAction}
      onConfirm={() => settle(true)}
    />
  ) : null;
  return { ask, dialog };
}
