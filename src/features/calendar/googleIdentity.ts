// Google Identity Services token client (owner 2026-10-12, experimental calendar). This is not the app's sign-in:
// that stays Supabase's Google provider. Here the member grants read-only calendar access in a Google popup, and the
// short-lived access token (about an hour, no refresh token) stays in this browser until it expires (`storedToken.ts`). The script is loaded only once the
// member has turned on experimental features. CSP: `public/_headers` allows accounts.google.com/gsi for it.

const GIS_SRC = "https://accounts.google.com/gsi/client";
export const CALENDAR_SCOPE = "https://www.googleapis.com/auth/calendar.readonly";

interface TokenResponse {
  access_token?: string;
  expires_in?: number | string;
  error?: string;
}

interface TokenClient {
  requestAccessToken(overrides?: { prompt?: string; login_hint?: string }): void;
}

interface GoogleOAuth2 {
  initTokenClient(config: {
    client_id: string;
    scope: string;
    callback: (response: TokenResponse) => void;
    error_callback?: (error: { type?: string }) => void;
  }): TokenClient;
  hasGrantedAllScopes(response: TokenResponse, ...scopes: string[]): boolean;
  revoke(token: string, done?: () => void): void;
}

declare global {
  interface Window {
    google?: { accounts?: { oauth2?: GoogleOAuth2 } };
  }
}

let loading: Promise<GoogleOAuth2> | null = null;

/** Loads the GIS script once. Call it ahead of the tap: a popup opened after an `await` may be blocked. */
export function loadGoogleIdentity(): Promise<GoogleOAuth2> {
  const ready = window.google?.accounts?.oauth2;
  if (ready) return Promise.resolve(ready);
  if (loading) return loading;
  loading = new Promise<GoogleOAuth2>((resolve, reject) => {
    const script = document.createElement("script");
    script.src = GIS_SRC;
    script.async = true;
    script.onload = () => {
      const oauth2 = window.google?.accounts?.oauth2;
      if (oauth2) resolve(oauth2);
      else reject(new Error("gis_unavailable"));
    };
    script.onerror = () => {
      loading = null;
      script.remove();
      reject(new Error("gis_load_failed"));
    };
    document.head.appendChild(script);
  });
  return loading;
}

/** Already loaded → the popup opens inside the same tap. */
export function googleIdentityIfLoaded(): GoogleOAuth2 | null {
  return window.google?.accounts?.oauth2 ?? null;
}

/** Google's default token lifetime, used when the response leaves `expires_in` out. */
const DEFAULT_EXPIRES_IN_SECONDS = 3600;

/**
 * Opens Google's popup and resolves with an access token for `calendar.readonly` and its lifetime in seconds.
 * `prompt: ""` shows the consent screen only the first time; later it closes by itself. Rejects when the member
 * closes it or unticks the scope.
 */
export function requestCalendarToken(oauth2: GoogleOAuth2, clientId: string, loginHint: string | undefined): Promise<{ token: string; expiresInSeconds: number }> {
  return new Promise((resolve, reject) => {
    const client = oauth2.initTokenClient({
      client_id: clientId,
      scope: CALENDAR_SCOPE,
      callback: (response) => {
        if (response.error || !response.access_token) reject(new Error(response.error ?? "calendar_no_token"));
        else if (!oauth2.hasGrantedAllScopes(response, CALENDAR_SCOPE)) reject(new Error("calendar_scope_denied"));
        else resolve({ token: response.access_token, expiresInSeconds: Number(response.expires_in) || DEFAULT_EXPIRES_IN_SECONDS });
      },
      error_callback: (error) => reject(new Error(error.type ?? "calendar_popup_failed")),
    });
    client.requestAccessToken({ prompt: "", ...(loginHint ? { login_hint: loginHint } : {}) });
  });
}

export function revokeCalendarToken(token: string): void {
  googleIdentityIfLoaded()?.revoke(token);
}
