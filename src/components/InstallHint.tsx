import { t } from "@/i18n/he";

type Platform = "ios" | "android" | "desktop";

function detectPlatform(): Platform {
  if (typeof navigator === "undefined") return "desktop";
  const ua = navigator.userAgent;
  if (/iPhone|iPad|iPod/.test(ua)) return "ios";
  if (/Android/.test(ua)) return "android";
  return "desktop";
}

/** True once the PWA is launched from the home-screen icon, not a browser tab. */
export function isStandalonePwa(): boolean {
  if (typeof window === "undefined") return false;
  return (
    window.matchMedia?.("(display-mode: standalone)").matches ||
    // iOS Safari's legacy flag (no `display-mode` media query support there
    // before recent versions).
    (window.navigator as Navigator & { standalone?: boolean }).standalone === true
  );
}

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
