import { useQuery } from "@tanstack/react-query";
import { Bell, Smartphone } from "lucide-react";
import { useEffect, useState } from "react";

import { InstallHint, isStandalonePwa } from "@/components/InstallHint";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { usePushSubscriptionStatus } from "@/features/auth/usePushSubscriptionStatus";
import { t } from "@/i18n/he";
import { clearInstallPrompt, useInstallPrompt } from "@/lib/installPrompt";
import { getCurrentPushSubscription, isPushSupported, subscribeToPush } from "@/lib/push";
import { detectPlatform } from "@/lib/pwaPlatform";
import { showDiagnosticErrorToast, showErrorToast } from "@/lib/rpc";

const SNOOZE_MS = 7 * 24 * 60 * 60 * 1000;
function useDismissal(kind: string) {
  const key = `carshare:device-setup:${kind}`;
  const [dismissed, setDismissed] = useState(() => {
    try { return Number(localStorage.getItem(key)) > Date.now(); } catch { return false; }
  });
  return [dismissed, () => {
    setDismissed(true);
    try { localStorage.setItem(key, String(Date.now() + SNOOZE_MS)); } catch { /* Storage may be disabled. */ }
  }] as const;
}

export function DeviceSetupPrompts() {
  const [installed, setInstalled] = useState(isStandalonePwa);
  const [installDismissed, dismissInstall] = useDismissal("install");
  const [pushDismissed, dismissPush] = useDismissal("push");
  const [busy, setBusy] = useState(false);
  const [installBusy, setInstallBusy] = useState(false);
  const [permission, setPermission] = useState(() => "Notification" in window ? Notification.permission : "default");
  const installPrompt = useInstallPrompt();
  const serverPush = usePushSubscriptionStatus();
  const needsInstallFirst = detectPlatform() === "ios" && !installed;
  const supported = isPushSupported();
  const localPush = useQuery({
    queryKey: ["device-push-subscription"],
    queryFn: getCurrentPushSubscription,
    enabled: supported && !needsInstallFirst && permission === "granted",
    staleTime: 30_000,
  });

  useEffect(() => {
    const markInstalled = () => setInstalled(true);
    const refresh = () => {
      if (isStandalonePwa()) setInstalled(true);
      if ("Notification" in window) setPermission(Notification.permission);
    };
    const displayMode = window.matchMedia?.("(display-mode: standalone)");
    displayMode?.addEventListener("change", refresh);
    window.addEventListener("appinstalled", markInstalled);
    window.addEventListener("focus", refresh);
    return () => {
      displayMode?.removeEventListener("change", refresh);
      window.removeEventListener("appinstalled", markInstalled);
      window.removeEventListener("focus", refresh);
    };
  }, []);

  async function enablePush() {
    setBusy(true);
    try {
      await subscribeToPush();
      await Promise.all([localPush.refetch(), serverPush.refresh()]);
    } catch (error) { showDiagnosticErrorToast(error); }
    finally {
      setPermission(Notification.permission);
      setBusy(false);
    }
  }

  async function install() {
    if (!installPrompt) return;
    setInstallBusy(true);
    try {
      await installPrompt.prompt();
      const choice = await installPrompt.userChoice;
      if (choice.outcome === "accepted") setInstalled(true);
      else dismissInstall();
    } catch (error) { showErrorToast(error); }
    finally { clearInstallPrompt(); setInstallBusy(false); }
  }

  const showInstall = !installed && !installDismissed;
  const subscribed = permission === "granted" && !!localPush.data && serverPush.isSubscribed;
  const checking = permission === "granted" && (localPush.isLoading || serverPush.isLoading);
  const showPush = supported && !needsInstallFirst && !pushDismissed && !subscribed && !checking;
  if (!showInstall && !showPush) return null;

  return <div className="space-y-3">
    {showInstall && <Card data-testid="install-suggestion">
      <CardContent className="space-y-3 p-4">
        <h2 className="flex items-center gap-2 font-semibold"><Smartphone className="size-5" aria-hidden="true" />{t("deviceSetup.installTitle")}</h2>
        <p className="text-sm text-muted-foreground">{t("deviceSetup.installBody")}</p>
        {!installPrompt && <InstallHint />}
        <div className="flex flex-wrap gap-2">
          {installPrompt && <Button className="min-h-11" disabled={installBusy} onClick={() => void install()}>{t("deviceSetup.install")}</Button>}
          <Button className="min-h-11" variant="ghost" onClick={dismissInstall}>{t("deviceSetup.later")}</Button>
        </div>
      </CardContent>
    </Card>}
    {showPush && <Card data-testid="notification-suggestion">
      <CardContent className="space-y-3 p-4">
        <h2 className="flex items-center gap-2 font-semibold"><Bell className="size-5" aria-hidden="true" />{t("deviceSetup.pushTitle")}</h2>
        <p className="text-sm text-muted-foreground">{t(permission === "denied" ? "deviceSetup.pushDenied" : "deviceSetup.pushBody")}</p>
        <div className="flex flex-wrap gap-2">
          {permission !== "denied" && <Button className="min-h-11" disabled={busy} onClick={() => void enablePush()}>{t("action.enablePush")}</Button>}
          <Button className="min-h-11" variant="ghost" onClick={dismissPush}>{t("deviceSetup.later")}</Button>
        </div>
      </CardContent>
    </Card>}
  </div>;
}
