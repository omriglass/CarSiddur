import { useState } from "react";

import { Button } from "@/components/ui/button";
import { InstallHint, isStandalonePwa } from "@/components/InstallHint";
import { t } from "@/i18n/he";

interface PushPermissionStepProps {
  onNext: () => void;
}

/**
 * Onboarding step 2 (UX_FLOWS.md §3.2): "אפשר התראות" button, or — on iOS
 * Safari not installed — the `InstallHint` card instead. UI-only for this
 * stage: it asks the browser's Notification permission but does **not**
 * subscribe (that needs a VAPID key + service worker registration wired to
 * `registerPushSubscription`, left for the push-notifications stage).
 */
export function PushPermissionStep({ onNext }: PushPermissionStepProps) {
  const [permission, setPermission] = useState<NotificationPermission | "unsupported">(
    typeof window !== "undefined" && "Notification" in window
      ? Notification.permission
      : "unsupported",
  );

  const isIos = typeof navigator !== "undefined" && /iPhone|iPad|iPod/.test(navigator.userAgent);
  const needsInstallFirst = isIos && !isStandalonePwa();

  async function handleEnable() {
    if (typeof window === "undefined" || !("Notification" in window)) {
      onNext();
      return;
    }
    const result = await Notification.requestPermission();
    setPermission(result);
    onNext();
  }

  if (needsInstallFirst) {
    return (
      <div className="space-y-4">
        <InstallHint />
        <Button variant="outline" className="w-full" onClick={onNext}>
          {t("action.installedAlready")}
        </Button>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <Button className="w-full" onClick={handleEnable}>
        {t("action.enablePush")}
      </Button>
      {permission === "denied" ? (
        <p className="text-sm text-muted-foreground">{t("onboarding.pushDeniedHint")}</p>
      ) : null}
    </div>
  );
}
