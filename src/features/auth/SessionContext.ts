import { createContext } from "react";
import type { Session } from "@supabase/supabase-js";

export interface SessionContextValue {
  session: Session | null;
  /** True until the first `getSession()`/`onAuthStateChange` resolves. */
  isLoading: boolean;
}

export const SessionContext = createContext<SessionContextValue | undefined>(undefined);
