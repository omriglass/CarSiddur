/**
 * The landing page (`/`) is the same for everyone — member, Sadran, admin — and is the
 * **last opened of the two main pages**: the published siddur or "my rides". A first visit
 * opens the siddur, because most people just want to see which car is available (REQ §13.87,
 * owner 2026-09-15; UX_FLOWS §2.1). Remembered per device in localStorage; every read/write is
 * wrapped so a private window or blocked storage still lands somewhere sensible.
 */
export const LANDING_STORAGE_KEY = "landing.lastMain";

export type MainPage = "/siddur" | "/my";

export const DEFAULT_MAIN_PAGE: MainPage = "/siddur";

/** Which main page a pathname belongs to, or `null` for any other screen. */
export function mainPageOf(pathname: string): MainPage | null {
  if (pathname === "/my") return "/my";
  if (pathname === "/siddur" || pathname.startsWith("/siddur/")) return "/siddur";
  return null;
}

/** The page `/` should open given what storage remembers (anything unknown → the default). */
export function landingPathFor(stored: string | null | undefined): MainPage {
  return stored === "/my" || stored === "/siddur" ? stored : DEFAULT_MAIN_PAGE;
}

export function readLandingPath(): MainPage {
  try {
    return landingPathFor(localStorage.getItem(LANDING_STORAGE_KEY));
  } catch {
    return DEFAULT_MAIN_PAGE;
  }
}

/** Called on every navigation; only the two main pages are remembered. */
export function rememberMainPage(pathname: string): void {
  const main = mainPageOf(pathname);
  if (!main) return;
  try {
    localStorage.setItem(LANDING_STORAGE_KEY, main);
  } catch {
    /* storage unavailable — the default landing still works */
  }
}
