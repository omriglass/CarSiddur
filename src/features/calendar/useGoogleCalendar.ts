import { useContext, useEffect, useState } from "react";
import { toast } from "sonner";

import { SessionContext } from "@/features/auth/SessionContext";
import { useExperimentalFeatures } from "@/features/member/useExperimentalFeatures";
import { he } from "@/i18n/he";
import { env } from "@/lib/env";

import { googleIdentityIfLoaded, loadGoogleIdentity, requestCalendarToken } from "./googleIdentity";
import { createGoogleCalendarSource } from "./googleSource";
import { SAMPLE_CALENDAR_IDS, createSampleCalendarSource } from "./sampleSource";
import { useCalendar } from "./useCalendar";

/**
 * The member's Google calendar connection for the "my rides" week view (owner 2026-10-12, EXPERIMENTAL). Available
 * only when the member turned on "allow experimental features" on this device AND the build has a Google client id
 * (`VITE_GOOGLE_CLIENT_ID`). `connect()` must run from a tap: it opens Google's popup synchronously when the script is
 * already loaded, which is why the script is preloaded as soon as the feature is available.
 */
export function useGoogleCalendar() {
  const { enabled } = useExperimentalFeatures();
  const clientId = env.VITE_GOOGLE_CLIENT_ID;
  const googleAvailable = enabled && !!clientId;
  // Dev builds can also use the fake sample calendar (`sampleSource.ts`), so the view is testable without a client id;
  // `import.meta.env.DEV` is false in production builds, which therefore never offer it.
  const sampleAvailable = enabled && import.meta.env.DEV;
  const available = googleAvailable || sampleAvailable;
  const { source, setSource, selectedCalendarIds, setSelectedCalendarIds } = useCalendar();
  // Only a hint for Google's account picker, so read without requiring a provider (unit tests render without one).
  const session = useContext(SessionContext)?.session ?? null;
  const [connecting, setConnecting] = useState(false);

  useEffect(() => {
    if (googleAvailable) loadGoogleIdentity().catch(() => {});
  }, [googleAvailable]);

  async function connect(): Promise<void> {
    if (!googleAvailable || !clientId || connecting) return;
    setConnecting(true);
    try {
      const oauth2 = googleIdentityIfLoaded() ?? (await loadGoogleIdentity());
      const token = await requestCalendarToken(oauth2, clientId, session?.user.email ?? undefined);
      const next = createGoogleCalendarSource(token);
      setSource(next);
      // First connection on this device: start with the member's own (primary) calendar.
      if (selectedCalendarIds.length === 0) {
        const primary = (await next.listCalendars()).find((calendar) => calendar.primary);
        if (primary) setSelectedCalendarIds([primary.id]);
      }
    } catch (error) {
      // Closing Google's popup is a choice, not a failure.
      if (!(error instanceof Error && error.message === "popup_closed")) toast.error(he.calendar.connectFailed);
    } finally {
      setConnecting(false);
    }
  }

  /** Dev only: swap in the sample calendar and tick its three calendars. */
  function connectSample() {
    if (!sampleAvailable) return;
    setSource(createSampleCalendarSource());
    setSelectedCalendarIds([...SAMPLE_CALENDAR_IDS]);
  }

  function disconnect() {
    source?.disconnect?.();
    setSource(null);
    setSelectedCalendarIds([]);
  }

  return {
    available,
    googleAvailable,
    sampleAvailable,
    connected: available && !!source,
    connecting,
    /** Calendars were picked on this device, but the page was reloaded (the token is gone) — one tap brings them back. */
    needsReconnect: googleAvailable && !source && selectedCalendarIds.length > 0,
    connect,
    connectSample,
    disconnect,
  };
}
