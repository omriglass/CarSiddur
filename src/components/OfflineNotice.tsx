import { useEffect, useState } from "react";

import { t } from "@/i18n/he";

function useOnlineStatus(): boolean {
  const [isOnline, setIsOnline] = useState(
    typeof navigator === "undefined" ? true : navigator.onLine,
  );

  useEffect(() => {
    const goOnline = () => setIsOnline(true);
    const goOffline = () => setIsOnline(false);
    window.addEventListener("online", goOnline);
    window.addEventListener("offline", goOffline);
    return () => {
      window.removeEventListener("online", goOnline);
      window.removeEventListener("offline", goOffline);
    };
  }, []);

  return isOnline;
}

/** Amber top banner while offline (UX_FLOWS.md §7.2 `OfflineBanner`). Renders nothing when online. */
export function OfflineNotice() {
  const isOnline = useOnlineStatus();
  if (isOnline) return null;

  return (
    <div
      role="status"
      className="w-full bg-amber-100 px-4 py-2 text-center text-sm text-amber-900"
    >
      {t("offline.banner")}
    </div>
  );
}
