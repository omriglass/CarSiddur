// AN1 (REQ item 225): the preferences this browser keeps for itself (never in the database), reported at most once a
// day so the owner can count what members use and see a device's setup when debugging. Values are short labels only.
import { readExperimentalEnabled } from "@/features/member/useExperimentalFeatures";
import { readNoAutoDialogs } from "@/features/member/useNoAutoDialogs";
import { readLandingPath } from "@/app/landing";
import { getStoredMode, getStoredThemeId } from "@/themes/apply";

const DEVICE_KEY = "carshare.deviceId.v1";
const REPORTED_KEY = "carshare.prefsReportedAt.v1";
export const REPORT_EVERY_MS = 24 * 60 * 60 * 1000;

function read(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function write(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    // storage may be denied (private browsing): then the device just reports again next time
  }
}

/** This browser's random id (not a fingerprint: it is lost with the site data). */
export function deviceId(): string {
  const stored = read(DEVICE_KEY);
  if (stored && stored.length >= 8) return stored;
  const id = crypto.randomUUID();
  write(DEVICE_KEY, id);
  return id;
}

function media(query: string): boolean {
  try {
    return typeof window.matchMedia === "function" && window.matchMedia(query).matches;
  } catch {
    return false;
  }
}

/** The browser-only preferences and setup, as `{key: short value}`. */
export function collectDevicePreferences(): Record<string, string | boolean> {
  return {
    theme: getStoredThemeId(),
    mode: getStoredMode(),
    experimental: readExperimentalEnabled(),
    noAutoDialogs: readNoAutoDialogs(),
    reduceMotion: read("a11y.reduceMotion.v1") === "1",
    landing: readLandingPath(),
    installed: media("(display-mode: standalone)"),
    device: media("(pointer: coarse)") ? "phone" : "desktop",
    notifications: typeof Notification === "undefined" ? "unsupported" : Notification.permission,
  };
}

/** True when this device has not reported in the last day. */
export function reportDue(nowMs: number): boolean {
  const last = Number(read(REPORTED_KEY) ?? 0);
  return !Number.isFinite(last) || nowMs - last >= REPORT_EVERY_MS;
}

export function markReported(nowMs: number): void {
  write(REPORTED_KEY, String(nowMs));
}
