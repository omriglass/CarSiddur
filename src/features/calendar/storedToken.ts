// The Google calendar access token, remembered on this device until it expires (owner 2026-10-22, REQ §13.126 b:
// "the calendar should not reset on every reload"). Google's token is short-lived (about an hour, no refresh
// token) and read-only; it stays in this browser only — never sent to our server — and is tied to the app user
// who connected it, so another user signing in on the same device never sees it. Dropped on disconnect, when
// Google rejects it, or once it is about to expire.
const STORAGE_KEY = "calendar.token.v1";
/** A token this close to expiring is not restored: the first fetch would fail anyway. */
const MIN_REMAINING_MS = 60_000;

export interface StoredCalendarToken {
  token: string;
  expiresAt: number;
  userId: string;
}

export function readStoredCalendarToken(userId: string, nowMs: number): string | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<StoredCalendarToken>;
    if (typeof parsed.token !== "string" || typeof parsed.expiresAt !== "number" || parsed.userId !== userId
      || parsed.expiresAt - nowMs < MIN_REMAINING_MS) {
      localStorage.removeItem(STORAGE_KEY);
      return null;
    }
    return parsed.token;
  } catch {
    return null;
  }
}

export function writeStoredCalendarToken(value: StoredCalendarToken): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(value));
  } catch {
    // A convenience only; storage may be denied in private browsing.
  }
}

export function clearStoredCalendarToken(): void {
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {
    // Nothing stored or storage denied — nothing to clear.
  }
}
