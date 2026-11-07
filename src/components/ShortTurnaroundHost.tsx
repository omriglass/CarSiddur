import { useCallback, useEffect, useState } from "react";

import { ConfirmDialog } from "@/components/ConfirmDialog";
import { he } from "@/i18n/he";
import { registerShortTurnaroundAsker, shortTurnaroundBody } from "@/lib/shortTurnaround";
import type { ShortTurnaroundInfo } from "@/lib/shortTurnaround";

interface Pending {
  info: Pick<ShortTurnaroundInfo, "at" | "name">;
  resolve: (accepted: boolean) => void;
}

/**
 * REQ §13.190: the one "תיאמתם עם X שצריך לקחת את הרכב ב-18:00?" dialog of the app. Mounted once in `main.tsx`;
 * the request submit and the siddur's ride moves reach it through `askShortTurnaround` (`lib/shortTurnaround.ts`).
 */
export function ShortTurnaroundHost() {
  const [pending, setPending] = useState<Pending | null>(null);
  const ask = useCallback(
    (info: Pending["info"]) => new Promise<boolean>((resolve) => { setPending({ info, resolve }); }),
    [],
  );
  useEffect(() => {
    registerShortTurnaroundAsker(ask);
    return () => registerShortTurnaroundAsker(null);
  }, [ask]);
  const settle = (accepted: boolean) => {
    pending?.resolve(accepted);
    setPending(null);
  };
  return pending ? (
    <ConfirmDialog
      open
      onOpenChange={(open) => { if (!open) settle(false); }}
      title={he.shortTurnaround.confirmTitle}
      description={shortTurnaroundBody(pending.info)}
      confirmLabel={he.shortTurnaround.confirmAction}
      onConfirm={() => settle(true)}
    />
  ) : null;
}
