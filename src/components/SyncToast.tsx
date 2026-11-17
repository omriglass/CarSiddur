import { useEffect, useSyncExternalStore } from "react";
import { toast } from "sonner";

import { he } from "@/i18n/he";
import { isSyncing, subscribeSyncing } from "@/lib/sessionPersist";

const TOAST_ID = "session-sync";

/**
 * Owner 2026-11-17: while the screen shows the copy saved on this device, an unmissable orange "מסנכרן…" (owner: "a bit jarring")
 * says it may be out of date; it goes away by itself when the fresh data arrives.
 */
export function SyncToast() {
  const syncing = useSyncExternalStore(subscribeSyncing, isSyncing, () => false);
  useEffect(() => {
    if (!syncing) {
      toast.dismiss(TOAST_ID);
      return;
    }
    toast.loading(he.common.syncing, {
      id: TOAST_ID,
      duration: Infinity,
      className: "!bg-orange-500 !text-orange-950 !border-orange-700 !font-semibold",
    });
  }, [syncing]);
  return null;
}
