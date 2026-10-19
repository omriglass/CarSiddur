import { createClient } from "@supabase/supabase-js";

import { withAppSurface } from "@/lib/appSurface";
import { env } from "@/lib/env";

import type { Database } from "./types";

/**
 * The browser only ever holds the anon (publishable) key; every read/write
 * this client makes is bounded by Row Level Security (ARCHITECTURE.md §1).
 * REQ §13.138 (c): database calls made while the Sadran board is open carry `x-app-surface: board` (`lib/appSurface.ts`).
 */
export const supabase = createClient<Database>(env.VITE_SUPABASE_URL, env.VITE_SUPABASE_ANON_KEY, {
  global: { fetch: (input, init) => fetch(input, withAppSurface(input, init)) },
});
