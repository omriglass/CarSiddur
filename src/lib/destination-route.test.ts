import { describe, expect, it, vi } from 'vitest';
import { handleDestinationRoute, type RouteDependencies } from '../../supabase/functions/destination-route/handler';

const department = '00000000-0000-0000-0000-000000000001';
const destination = '00000000-0000-0000-0000-000000000201';
function setup(overrides: Partial<RouteDependencies> = {}) {
  return { authenticate: vi.fn().mockResolvedValue(true), canManage: vi.fn().mockResolvedValue(true),
    loadPlaces: vi.fn().mockResolvedValue({ origin: { name: 'Home', lat: 32, lng: 35 },
      destination: { name: 'Destination', lat: null, lng: null } }), apiKey: 'server-secret',
    fetch: vi.fn().mockResolvedValue(Response.json({ routes: [{ distanceMeters: 12345, duration: '721s' }] })),
    ...overrides } satisfies RouteDependencies;
}
function request(body: unknown = { department_id: department, destination_id: destination }, token = 'Bearer user-token') {
  return new Request('https://test/destination-route', { method: 'POST',
    headers: { Authorization: token, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
}
describe('Google route estimates', () => {
  it('uses department origin, Israel address fallback and safe unit conversion', async () => {
    const deps = setup();
    const result = await handleDestinationRoute(request(), deps);
    expect(await result.json()).toEqual({ distance_km: 12.3, travel_minutes: 13 });
    expect(deps.canManage).toHaveBeenCalledWith('user-token', department);
    expect(deps.loadPlaces).toHaveBeenCalledWith('user-token', department, destination);
    const [url, init] = vi.mocked(deps.fetch).mock.calls[0]!;
    expect(url).toBe('https://routes.googleapis.com/directions/v2:computeRoutes');
    expect(JSON.parse(init!.body as string)).toMatchObject({
      origin: { location: { latLng: { latitude: 32, longitude: 35 } } }, destination: { address: 'Destination' },
      regionCode: 'IL', travelMode: 'DRIVE', routingPreference: 'TRAFFIC_UNAWARE',
    });
    expect(init!.headers).toMatchObject({ 'X-Goog-FieldMask': 'routes.distanceMeters,routes.duration' });
  });
  it.each(['', 'Basic token'])('rejects missing/invalid bearer before catalog access: %s', async (token) => {
    const deps = setup();
    expect((await handleDestinationRoute(request(undefined, token), deps)).status).toBe(401);
    expect(deps.loadPlaces).not.toHaveBeenCalled();
    expect(deps.fetch).not.toHaveBeenCalled();
  });
  it('rejects a bearer rejected by Supabase Auth', async () => {
    const deps = setup({ authenticate: vi.fn().mockResolvedValue(false) });
    expect((await handleDestinationRoute(request(), deps)).status).toBe(401);
    expect(deps.fetch).not.toHaveBeenCalled();
  });
  it('rejects members and temporary coordinators before catalog or Google access', async () => {
    const deps = setup({ canManage: vi.fn().mockResolvedValue(false) });
    expect((await handleDestinationRoute(request(), deps)).status).toBe(403);
    expect(deps.loadPlaces).not.toHaveBeenCalled();
    expect(deps.fetch).not.toHaveBeenCalled();
  });
  it('requires valid department and destination IDs', async () => {
    const deps = setup();
    expect((await handleDestinationRoute(request({ department_id: department, destination_id: 'foreign-address' }), deps)).status).toBe(400);
    expect(deps.canManage).not.toHaveBeenCalled();
  });
  it.each([
    [null, { name: 'Destination', lat: null, lng: null }, 'home_not_configured'],
    [{ name: 'Home', lat: null, lng: null }, null, 'destination_not_found'],
  ] as const)('does not call Google for missing or out-of-department places', async (origin, target, code) => {
    const deps = setup({ loadPlaces: vi.fn().mockResolvedValue({ origin, destination: target }) });
    expect(await (await handleDestinationRoute(request(), deps)).json()).toEqual({ error: { code } });
    expect(deps.fetch).not.toHaveBeenCalled();
  });
  it('reports missing configuration without attempting external requests', async () => {
    const deps = setup({ apiKey: '' });
    const result = await handleDestinationRoute(request(), deps);
    expect(result.status).toBe(503);
    expect(await result.json()).toEqual({ error: { code: 'maps_not_configured' } });
    expect(deps.fetch).not.toHaveBeenCalled();
  });
  it('does not expose upstream failures or secrets', async () => {
    const deps = setup({ fetch: vi.fn().mockResolvedValue(new Response('server-secret', { status: 403 })) });
    expect(await (await handleDestinationRoute(request(), deps)).json()).toEqual({ error: { code: 'maps_request_failed' } });
  });
  it('handles no available route', async () => {
    const deps = setup({ fetch: vi.fn().mockResolvedValue(Response.json({ routes: [] })) });
    expect(await (await handleDestinationRoute(request(), deps)).json()).toEqual({ error: { code: 'route_not_found' } });
  });
  it('rejects malformed distance/time instead of saving NaN', async () => {
    const deps = setup({ fetch: vi.fn().mockResolvedValue(Response.json({ routes: [{ distanceMeters: -1, duration: 'bad' }] })) });
    expect((await handleDestinationRoute(request(), deps)).status).toBe(502);
  });
  it('handles network timeouts safely', async () => {
    const deps = setup({ fetch: vi.fn().mockRejectedValue(new Error('secret upstream details')) });
    expect(await (await handleDestinationRoute(request(), deps)).json()).toEqual({ error: { code: 'maps_request_failed' } });
  });
});
