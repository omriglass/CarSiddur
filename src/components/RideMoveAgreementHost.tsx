import { useCallback, useEffect, useState } from "react";

import { ConfirmDialog } from "@/components/ConfirmDialog";
import { he, tv } from "@/i18n/he";
import { registerRideAgreementAsker } from "@/lib/rideMoveAgreement";

interface Pending {
  names: string;
  resolve: (accepted: boolean) => void;
}

/**
 * REQ §13.179 (b): the one "דיברת עם X על השינוי?" dialog for a member moving a ride others ride on. Mounted once in
 * `main.tsx`; `editRide` reaches it through `withRideAgreementRetry`.
 */
export function RideMoveAgreementHost() {
  const [pending, setPending] = useState<Pending | null>(null);
  const ask = useCallback((names: string) => new Promise<boolean>((resolve) => { setPending({ names, resolve }); }), []);
  useEffect(() => {
    registerRideAgreementAsker(ask);
    return () => registerRideAgreementAsker(null);
  }, [ask]);
  const settle = (accepted: boolean) => {
    pending?.resolve(accepted);
    setPending(null);
  };
  const names = pending?.names || he.rideMoveAgreement.othersFallback;
  return pending ? (
    <ConfirmDialog
      open
      onOpenChange={(open) => { if (!open) settle(false); }}
      title={tv("rideMoveAgreement.title", { names })}
      description={tv("rideMoveAgreement.body", { names })}
      confirmLabel={he.rideMoveAgreement.confirm}
      onConfirm={() => settle(true)}
    />
  ) : null;
}
