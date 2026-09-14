import { t } from "@/i18n/he";
import { detectPlatform } from "@/lib/pwaPlatform";

type Platform = "ios" | "android" | "desktop";

const COPY_BY_PLATFORM: Record<Platform, string> = {
  ios: t("installHint.ios"),
  android: t("installHint.android"),
  desktop: t("installHint.desktop"),
};

/**
 * Platform-detected "add to home screen" instructions (UX_FLOWS.md §3.2,
 * component inventory `InstallHint`). Notifications only work reliably on
 * iOS once the PWA is installed, so onboarding/profile show this in place
 * of the enable-push button until then.
 */
export function InstallHint() {
  const platform = detectPlatform();
  return (
    <div className="rounded-md border bg-muted/40 p-4 text-sm text-muted-foreground" role="note">
      <p>{COPY_BY_PLATFORM[platform]}</p>
    </div>
  );
}
