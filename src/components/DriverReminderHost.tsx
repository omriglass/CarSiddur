import { useCallback, useEffect, useState } from "react";

import { ConfirmDialog } from "@/components/ConfirmDialog";
import { registerDriverReminderAsker } from "@/features/member/driverReminder";
import { he } from "@/i18n/he";

/** REQ §13.191 (DR2): the one "להזכיר לך 30 דקות לפני היציאה?" dialog of the app, mounted once in `main.tsx`. */
export function DriverReminderHost() {
  const [resolve, setResolve] = useState<((accepted: boolean) => void) | null>(null);
  const ask = useCallback(() => new Promise<boolean>((done) => { setResolve(() => done); }), []);
  useEffect(() => {
    registerDriverReminderAsker(ask);
    return () => registerDriverReminderAsker(null);
  }, [ask]);
  const settle = (accepted: boolean) => {
    resolve?.(accepted);
    setResolve(null);
  };
  return resolve ? (
    <ConfirmDialog
      open
      onOpenChange={(open) => { if (!open) settle(false); }}
      title={he.driverReminder.askTitle}
      description={he.driverReminder.askBody}
      confirmLabel={he.driverReminder.askYes}
      cancelLabel={he.driverReminder.askNo}
      onConfirm={() => settle(true)}
    />
  ) : null;
}
