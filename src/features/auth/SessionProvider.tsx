import { useEffect, useMemo, useState, type ReactNode } from "react";
import type { Session } from "@supabase/supabase-js";

import { supabase } from "@/integrations/supabase/client";
import { SessionContext, type SessionContextValue } from "./SessionContext";

/**
 * Wraps the app once (in `main.tsx`) and tracks the Supabase auth session via
 * `onAuthStateChange` (ARCHITECTURE.md §8: Google sign-in only in production,
 * email/password for seeded demo users in dev). Everything else (`useSession`,
 * `useProfile`, route guards) reads from this single subscription instead of
 * each calling `supabase.auth.getSession()` independently.
 */
export function SessionProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    let isMounted = true;

    supabase.auth.getSession().then(({ data }) => {
      if (!isMounted) return;
      setSession(data.session);
      setIsLoading(false);
    });

    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((_event, nextSession) => {
      if (!isMounted) return;
      setSession(nextSession);
      setIsLoading(false);
    });

    return () => {
      isMounted = false;
      subscription.unsubscribe();
    };
  }, []);

  const value = useMemo<SessionContextValue>(() => ({ session, isLoading }), [session, isLoading]);

  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}
