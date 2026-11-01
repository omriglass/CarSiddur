import { corsHeaders } from '../_shared/cors.ts';
import { bearerToken } from '../_shared/request.ts';

export interface RoutePlace { name: string; lat: number | null; lng: number | null }
export interface RouteDependencies {
  authenticate: (jwt: string) => Promise<boolean>;
  canManage: (jwt: string, departmentId: string) => Promise<boolean>;
  loadPlaces: (jwt: string, departmentId: string, destinationId: string) => Promise<{
    origin: RoutePlace | null; destination: RoutePlace | null;
  }>;
  apiKey: string;
  fetch: typeof fetch;
}
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function response(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
}
function failure(code: string, status: number) { return response({ error: { code } }, status); }
export function waypoint(place: RoutePlace) {
  if (place.lat !== null && place.lng !== null && Number.isFinite(place.lat) && Number.isFinite(place.lng)
    && Math.abs(place.lat) <= 90 && Math.abs(place.lng) <= 180) {
    return { location: { latLng: { latitude: place.lat, longitude: place.lng } } };
  }
  return { address: place.name };
}
/** At most this many places per "locate" call (the browser sends the missing ones in batches). */
export const LOCATE_BATCH = 10;

/**
 * REQ §13.175 (e): where a place is, read from the same Routes API the estimate uses — the route from home to the
 * place's name ends at the place (`legs[0].endLocation`). No other Google API has to be enabled.
 */
async function locate(deps: RouteDependencies, origin: RoutePlace, place: RoutePlace): Promise<{ lat: number; lng: number } | null> {
  const googleResponse = await deps.fetch('https://routes.googleapis.com/directions/v2:computeRoutes', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Goog-Api-Key': deps.apiKey, 'X-Goog-FieldMask': 'routes.legs.endLocation' },
    body: JSON.stringify({ origin: waypoint(origin), destination: { address: place.name },
      travelMode: 'DRIVE', routingPreference: 'TRAFFIC_UNAWARE', regionCode: 'IL', units: 'METRIC' }),
    signal: AbortSignal.timeout(15000),
  });
  if (!googleResponse.ok) return null;
  const latLng = (await googleResponse.json())?.routes?.[0]?.legs?.[0]?.endLocation?.latLng;
  const lat = Number(latLng?.latitude);
  const lng = Number(latLng?.longitude);
  return Number.isFinite(lat) && Number.isFinite(lng) && Math.abs(lat) <= 90 && Math.abs(lng) <= 180
    ? { lat: Math.round(lat * 1e6) / 1e6, lng: Math.round(lng * 1e6) / 1e6 } : null;
}

/** No writes: a coordinator reviews the estimate (or the located places) and the app saves them. */
export async function handleDestinationRoute(req: Request, deps: RouteDependencies): Promise<Response> {
  if (req.method === 'OPTIONS') return response({ ok: true });
  if (req.method !== 'POST') return failure('method_not_allowed', 405);
  try {
    const jwt = bearerToken(req);
    if (!jwt || !(await deps.authenticate(jwt))) return failure('not_authorized', 401);
    let body: unknown;
    try { body = await req.json(); } catch { return failure('invalid_request', 400); }
    if (!body || typeof body !== 'object') return failure('invalid_request', 400);
    const { department_id: departmentId, destination_id: destinationId, mode, destination_ids: destinationIds } = body as Record<string, unknown>;
    if (mode === 'locate') {
      if (typeof departmentId !== 'string' || !uuid.test(departmentId) || !Array.isArray(destinationIds) || !destinationIds.length
        || destinationIds.length > LOCATE_BATCH || !destinationIds.every((id) => typeof id === 'string' && uuid.test(id))) return failure('invalid_request', 400);
      if (!(await deps.canManage(jwt, departmentId))) return failure('not_authorized', 403);
      if (!deps.apiKey) return failure('maps_not_configured', 503);
      const results = [];
      for (const id of destinationIds as string[]) {
        const { origin, destination } = await deps.loadPlaces(jwt, departmentId, id);
        if (!origin) return failure('home_not_configured', 422);
        const at = destination ? await locate(deps, origin, destination) : null;
        results.push(at ? { id, ...at } : { id, error: destination ? 'not_found' : 'destination_not_found' });
      }
      return response({ results });
    }
    if (typeof departmentId !== 'string' || !uuid.test(departmentId)
      || typeof destinationId !== 'string' || !uuid.test(destinationId)) return failure('invalid_request', 400);
    if (!(await deps.canManage(jwt, departmentId))) return failure('not_authorized', 403);
    const { origin, destination } = await deps.loadPlaces(jwt, departmentId, destinationId);
    if (!origin) return failure('home_not_configured', 422);
    if (!destination) return failure('destination_not_found', 404);
    if (!deps.apiKey) return failure('maps_not_configured', 503);
    const googleResponse = await deps.fetch('https://routes.googleapis.com/directions/v2:computeRoutes', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Goog-Api-Key': deps.apiKey,
        'X-Goog-FieldMask': 'routes.distanceMeters,routes.duration' },
      body: JSON.stringify({ origin: waypoint(origin), destination: waypoint(destination),
        travelMode: 'DRIVE', routingPreference: 'TRAFFIC_UNAWARE', regionCode: 'IL', units: 'METRIC' }),
      signal: AbortSignal.timeout(15000),
    });
    if (!googleResponse.ok) return failure('maps_request_failed', 502);
    const result = await googleResponse.json();
    const route = result?.routes?.[0];
    if (!route) return failure('route_not_found', 422);
    const seconds = typeof route.duration === 'string' && /^\d+(\.\d+)?s$/.test(route.duration)
      ? Number(route.duration.slice(0, -1)) : NaN;
    if (typeof route.distanceMeters !== 'number' || !Number.isFinite(route.distanceMeters)
      || route.distanceMeters < 0 || !Number.isFinite(seconds)) return failure('maps_request_failed', 502);
    return response({ distance_km: Math.round(route.distanceMeters / 100) / 10, travel_minutes: Math.ceil(seconds / 60) });
  } catch {
    // Never forward upstream error bodies, keys, or infrastructure details.
    return failure('maps_request_failed', 502);
  }
}
