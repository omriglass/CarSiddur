// supabase/functions/_shared/supabaseAdmin.ts
//
// Service-role Supabase client factory shared by every Edge Function.
// ARCHITECTURE.md §8: "Inside, they use the service role only to call the
// specific RPCs listed in §3; they never issue raw table writes" — reads via
// `.from()` are fine (used for building solver inputs and read-only lookups),
// but state changes should go through the SECURITY DEFINER RPCs.

import { createClient, type SupabaseClient } from 'npm:@supabase/supabase-js@2';
import { requireEnv } from './env.ts';

let cached: SupabaseClient | null = null;

export function getServiceRoleClient(): SupabaseClient {
  if (cached) return cached;
  const url = requireEnv('SUPABASE_URL');
  const key = requireEnv('SUPABASE_SERVICE_ROLE_KEY');
  cached = createClient(url, key, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  return cached;
}

/** Verifies a user JWT (e.g. an Authorization header the client also sent) with the anon client. */
export async function getUserFromJwt(jwt: string): Promise<{ id: string; email?: string } | null> {
  const url = requireEnv('SUPABASE_URL');
  const anonKey = Deno.env.get('SUPABASE_ANON_KEY') ?? requireEnv('SUPABASE_SERVICE_ROLE_KEY');
  const client = createClient(url, anonKey, { auth: { autoRefreshToken: false, persistSession: false } });
  const { data, error } = await client.auth.getUser(jwt);
  if (error || !data.user) return null;
  return { id: data.user.id, email: data.user.email ?? undefined };
}
