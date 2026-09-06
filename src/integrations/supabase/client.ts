import { createClient } from "@supabase/supabase-js";

import { env } from "@/lib/env";

import type { Database } from "./types";

/**
 * The browser only ever holds the anon (publishable) key; every read/write
 * this client makes is bounded by Row Level Security (ARCHITECTURE.md §1).
 */
export const supabase = createClient<Database>(env.VITE_SUPABASE_URL, env.VITE_SUPABASE_ANON_KEY);
