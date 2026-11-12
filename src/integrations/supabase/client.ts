import { createClient } from "@supabase/supabase-js";

import { withAppSurface } from "@/lib/appSurface";
import { env } from "@/lib/env";
import { createSlowCallTracker, timedFetch } from "@/lib/slowCalls";
import { withTabId } from "@/lib/tabId";

import type { Database } from "./types";

/**
 * The browser only ever holds the anon (publishable) key; every read/write
 * this client makes is bounded by Row Level Security (ARCHITECTURE.md §1).
 * REQ §13.138 (c): database calls made while the Sadran board is open carry `x-app-surface: board` (`lib/appSurface.ts`).
 * O28-8: every database call carries this page's `x-tab-id` (`lib/tabId.ts`).
 * PF1: every call is timed; slow ones are summarized to `client_errors` once the page is quiet (`lib/slowCalls.ts`).
 */
const slowCalls = createSlowCallTracker({
  // Loaded lazily: the reporter itself uses this client.
  report: ({ message, detail }) => {
    void import("@/features/diagnostics/reportClientError")
      .then(({ reportClientError }) => reportClientError({ message, stack: detail, context: "perf:slow" }))
      .catch(() => undefined);
  },
});
const timed = timedFetch(slowCalls, (input, init) => fetch(input, init));

export const supabase = createClient<Database>(env.VITE_SUPABASE_URL, env.VITE_SUPABASE_ANON_KEY, {
  global: { fetch: (input, init) => timed(input, withTabId(input, withAppSurface(input, init))) },
});
