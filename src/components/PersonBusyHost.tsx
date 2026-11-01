import { useCallback, useEffect, useState } from "react";

import { ConfirmDialog } from "@/components/ConfirmDialog";
import { useSession } from "@/features/auth/useSession";
import { he } from "@/i18n/he";
import { personBusyBody, registerPersonBusyAsker, type PersonBusyInfo } from "@/lib/personBusy";

interface Pending {
  info: PersonBusyInfo;
  resolve: (accepted: boolean) => void;
}

/**
 * REQ §13.176: the one "כבר בנסיעה אחרת בשעות האלה - להמשיך בכל זאת?" dialog of the app. Mounted once in `main.tsx`;
 * the `api.ts` wrappers of the RPCs that check it reach it through `withPersonBusyRetry`.
 */
export function PersonBusyHost() {
  const { session } = useSession();
  const [pending, setPending] = useState<Pending | null>(null);
  const ask = useCallback((info: PersonBusyInfo) => new Promise<boolean>((resolve) => { setPending({ info, resolve }); }), []);
  useEffect(() => {
    registerPersonBusyAsker(ask);
    return () => registerPersonBusyAsker(null);
  }, [ask]);
  const settle = (accepted: boolean) => {
    pending?.resolve(accepted);
    setPending(null);
  };
  return pending ? (
    <ConfirmDialog
      open
      onOpenChange={(open) => { if (!open) settle(false); }}
      title={he.personBusy.title}
      description={personBusyBody(pending.info, session?.user.id)}
      confirmLabel={he.personBusy.confirm}
      onConfirm={() => settle(true)}
    />
  ) : null;
}
