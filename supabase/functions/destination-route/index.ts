import { createClient } from 'npm:@supabase/supabase-js@2';
import { requireEnv, optionalEnv } from '../_shared/env.ts';
import { getUserFromJwt } from '../_shared/supabaseAdmin.ts';
import { handleDestinationRoute } from './handler.ts';

function caller(jwt: string) {
  return createClient(requireEnv('SUPABASE_URL'), requireEnv('SUPABASE_ANON_KEY'), {
    global: { headers: { Authorization: `Bearer ${jwt}` } },
    auth: { persistSession: false, autoRefreshToken: false },
  });
}
Deno.serve((req: Request) => handleDestinationRoute(req, {
  authenticate: async (jwt) => !!(await getUserFromJwt(jwt)),
  canManage: async (jwt, departmentId) => {
    const { data, error } = await caller(jwt).rpc('can_manage_operations', { p_department_id: departmentId });
    return !error && data === true;
  },
  loadPlaces: async (jwt, departmentId, destinationId) => {
    const client = caller(jwt);
    const { data: department, error: departmentError } = await client.from('departments')
      .select('home_destination_id').eq('id', departmentId).eq('is_active', true).maybeSingle();
    if (departmentError) throw departmentError;
    if (!department?.home_destination_id) return { origin: null, destination: null };
    const { data: places, error } = await client.from('destinations').select('id,name,lat,lng')
      .eq('department_id', departmentId).in('id', [department.home_destination_id, destinationId]);
    if (error) throw error;
    return {
      origin: places?.find((place) => place.id === department.home_destination_id) ?? null,
      destination: places?.find((place) => place.id === destinationId) ?? null,
    };
  },
  apiKey: optionalEnv('GOOGLE_MAPS_API_KEY'),
  fetch,
}));
