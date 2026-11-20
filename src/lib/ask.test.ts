import { describe, expect, it, vi } from 'vitest';
import { AskError, handleAsk, type AskDependencies } from '../../supabase/functions/ask/handler';
import { buildAskContext, jerusalemWallClock, type AskContextRow } from '../../supabase/functions/_shared/askContext';
import { normalizeAnswer, type AskModelAnswer } from '../../supabase/functions/_shared/askNormalize';
import { buildUserTurn } from '../../supabase/functions/_shared/askPrompt';

// REQ item 258 (AI1): the `ask` edge function with a fake Gemini — CI never calls Google.
const department = '00000000-0000-0000-0000-000000000001';
const conversation = '00000000-0000-0000-0000-0000000000c1';
const ride1 = '00000000-0000-0000-0000-000000000211';
const ride2 = '00000000-0000-0000-0000-000000000212';
// Wednesday 2026-11-18 21:00 in Israel (19:00 UTC, winter time)
const NOW = new Date('2026-11-18T19:00:00Z');

const row: AskContextRow = {
  home: 'Home',
  places: [{ name: 'Home', aliases: ['house'] }, { name: 'Haifa', aliases: [] }, { name: 'Binyamina' }],
  people: [{ name: 'Noa', kind: 'child' }, { name: 'Dana', kind: 'member', drives: true }],
  rides: [
    { request_id: ride1, date: '2026-11-22', start: '08:00', end: '12:00', trip_type: 'round_trip', origin: 'Home', destination: 'Haifa', stops: [], people: ['Dana'] },
    { request_id: ride2, date: '2026-11-22', start: '16:00', end: '18:00', trip_type: 'round_trip', origin: 'Home', destination: 'Binyamina', stops: [], people: [] },
  ],
};

function gemini(answer: Partial<AskModelAnswer>, status = 200) {
  return status === 200
    ? Response.json({ candidates: [{ content: { parts: [{ text: JSON.stringify({ matching_rides: [], ...answer }) }] } }] })
    : new Response('{}', { status });
}

function setup(overrides: Partial<AskDependencies> = {}) {
  return {
    authenticate: vi.fn().mockResolvedValue('profile-1'),
    loadContext: vi.fn().mockResolvedValue(row),
    beginTurn: vi.fn().mockResolvedValue({ conversation_id: conversation, position: 1, previous_draft: null, messages: [] }),
    recordTurn: vi.fn().mockResolvedValue('turn-1'),
    apiKey: 'test-key',
    model: 'test-model',
    fetch: vi.fn().mockResolvedValue(gemini({ intent: 'new_request', date: '2026-11-19', time: '10:00', time_mode: 'arrive_by',
      destination: { text: 'binyamina', list_name: 'Binyamina' } })),
    now: () => NOW,
    ...overrides,
  } satisfies AskDependencies;
}
function request(body: unknown = { department_id: department, message: 'binyamina tomorrow by 10' }, token = 'Bearer user-token') {
  return new Request('https://test/ask', { method: 'POST', headers: { Authorization: token, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
}

describe('ask context', () => {
  it('reads the Israel wall clock and builds a 14-day calendar from today', () => {
    expect(jerusalemWallClock(NOW)).toEqual({ date: '2026-11-18', time: '21:00' });
    const { context, refs } = buildAskContext(row, NOW);
    expect(context.now).toBe('2026-11-18T21:00');
    expect(context.weekday).toBe('Wednesday');
    expect(context.calendar).toHaveLength(14);
    expect(context.calendar[0]).toEqual({ date: '2026-11-18', weekday: 'Wednesday' });
    expect(context.calendar[13]).toEqual({ date: '2026-12-01', weekday: 'Tuesday' });
    expect(context.places).toEqual([{ name: 'Home', aliases: ['house'] }, { name: 'Haifa' }, { name: 'Binyamina' }]);
    // no request id reaches the model
    expect(JSON.stringify(context)).not.toContain(ride1);
    expect(context.my_rides.map((r) => [r.ref, r.weekday])).toEqual([['RIDE_1', 'Sunday'], ['RIDE_2', 'Sunday']]);
    expect(refs).toEqual({ RIDE_1: ride1, RIDE_2: ride2 });
  });

  it('crosses the day boundary in Israel time, not UTC', () => {
    expect(jerusalemWallClock(new Date('2026-11-18T22:30:00Z'))).toEqual({ date: '2026-11-19', time: '00:30' });
    expect(jerusalemWallClock(new Date('2026-07-01T21:30:00Z'))).toEqual({ date: '2026-07-02', time: '00:30' });
  });

  it('adds the previous draft and earlier messages to a follow-up turn only', () => {
    const { context } = buildAskContext(row, NOW);
    expect(buildUserTurn(context, 'x')).not.toContain('Draft so far');
    const text = buildUserTurn(context, 'at ten', { draft: { intent: 'new_request' }, messages: ['to haifa tomorrow'] });
    expect(text).toContain('Draft so far:\n{"intent":"new_request"}');
    expect(text).toContain('Earlier messages:\n["to haifa tomorrow"]');
  });
});

describe('normalizeAnswer follow-ups and flags', () => {
  const { context } = buildAskContext(row, NOW);
  it('keeps the previous draft where the new answer is empty', () => {
    const first = normalizeAnswer({ intent: 'new_request', date: '2026-11-19', destination: { text: 'haifa', list_name: 'Haifa' } }, context);
    expect(first.ask).toBe('what_time');
    const second = normalizeAnswer({ intent: 'unclear', time: '10:00', time_mode: 'depart' }, context, first);
    expect(second).toMatchObject({ intent: 'new_request', date: '2026-11-19', time: '10:00', ask: null, destination: { list_name: 'Haifa' } });
    expect(second.flags).toEqual(expect.arrayContaining(['intent_kept', 'kept_previous']));
  });
  it('one way drops the kept return time', () => {
    const first = normalizeAnswer({ intent: 'new_request', date: '2026-11-19', time: '08:00', return_time: '12:00', destination: { text: 'haifa', list_name: 'Haifa' } }, context);
    const second = normalizeAnswer({ intent: 'new_request', trip_type: 'one_way' }, context, first);
    expect(second.return_time).toBeNull();
    expect(second.trip_type).toBe('one_way');
  });
  it('an edit keeps its ride across turns', () => {
    const first = normalizeAnswer({ intent: 'edit_request', matching_rides: ['RIDE_1'] }, context);
    expect(first.target_ride).toBe('RIDE_1');
    const second = normalizeAnswer({ intent: 'edit_request', end_shift_minutes: 60 }, context, first);
    expect(second).toMatchObject({ target_ride: 'RIDE_1', return_time: '13:00', ask: null });
  });
  it('flags what our checks dropped or left to the member', () => {
    const draft = normalizeAnswer({ intent: 'edit_request', matching_rides: ['RIDE_1', 'RIDE_2', 'RIDE_9'], date: '2027-01-01',
      destination: { text: 'tel aviv', list_name: 'Tel Aviv' }, time: '25:00' }, context);
    expect(draft.flags).toEqual(expect.arrayContaining(['date_dropped', 'place_unlisted', 'time_dropped', 'ride_unknown', 'ride_ambiguous']));
    expect(draft).toMatchObject({ target_ride: null, ride_choices: ['RIDE_1', 'RIDE_2'], ask: 'which_ride', date: null, time: null,
      destination: { text: 'tel aviv', list_name: null } });
  });
});

describe('ask edge function', () => {
  it('returns the checked draft and the ride refs, and records the turn', async () => {
    const deps = setup();
    const res = await handleAsk(request(), deps);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ conversation_id: conversation, turn_id: 'turn-1', refs: { RIDE_1: ride1 },
      draft: { intent: 'new_request', date: '2026-11-19', time: '10:00', destination: { list_name: 'Binyamina' }, ask: null } });
    expect(deps.loadContext).toHaveBeenCalledWith('user-token', department);
    expect(deps.beginTurn).toHaveBeenCalledWith('profile-1', department, null);
    const [url, init] = vi.mocked(deps.fetch).mock.calls[0]!;
    expect(url).toBe('https://generativelanguage.googleapis.com/v1beta/models/test-model:generateContent');
    expect((init!.headers as Record<string, string>)['x-goog-api-key']).toBe('test-key');
    const sent = JSON.parse(init!.body as string);
    expect(sent.generationConfig).toMatchObject({ temperature: 0, responseMimeType: 'application/json' });
    expect(JSON.stringify(sent)).not.toContain(ride1);
    const [, , turn] = vi.mocked(deps.recordTurn).mock.calls[0]!;
    expect(turn).toMatchObject({ user_text: 'binyamina tomorrow by 10', error: null, model: 'test-model', draft: { intent: 'new_request' } });
  });

  it('continues a conversation from the stored draft, or from the draft the app sends', async () => {
    const previous = normalizeAnswer({ intent: 'new_request', date: '2026-11-19', destination: { text: 'haifa', list_name: 'Haifa' } }, buildAskContext(row, NOW).context);
    const deps = setup({
      beginTurn: vi.fn().mockResolvedValue({ conversation_id: conversation, position: 2, previous_draft: previous, messages: ['haifa tomorrow'] }),
      fetch: vi.fn().mockResolvedValue(gemini({ intent: 'new_request', time: '09:00' })),
    });
    const body = await (await handleAsk(request({ department_id: department, conversation_id: conversation, message: 'at nine' }), deps)).json();
    expect(body.draft).toMatchObject({ date: '2026-11-19', time: '09:00', destination: { list_name: 'Haifa' } });
    expect(JSON.parse(vi.mocked(deps.fetch).mock.calls[0]![1]!.body as string).contents[0].parts[0].text).toContain('haifa tomorrow');

    const chosen = { ...previous, intent: 'edit_request' as const, target_ride: 'RIDE_2', ride_choices: [] };
    const deps2 = setup({ fetch: vi.fn().mockResolvedValue(gemini({ intent: 'edit_request', end_shift_minutes: 30 })) });
    const body2 = await (await handleAsk(request({ department_id: department, message: 'half an hour longer', draft: chosen }), deps2)).json();
    expect(body2.draft).toMatchObject({ target_ride: 'RIDE_2', return_time: '18:30' });
  });

  it('refuses without a session, a bad body, or without the admin opt-in', async () => {
    expect((await handleAsk(request(undefined, ''), setup())).status).toBe(401);
    expect((await handleAsk(request({ department_id: 'x', message: 'hi' }), setup())).status).toBe(400);
    expect((await handleAsk(request({ department_id: department, message: '   ' }), setup())).status).toBe(400);
    expect((await handleAsk(request({ department_id: department, message: 'x'.repeat(1001) }), setup())).status).toBe(400);
    const deps = setup({ loadContext: vi.fn().mockRejectedValue(new AskError('not_authorized')) });
    const res = await handleAsk(request(), deps);
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: { code: 'not_authorized' } });
    expect(deps.fetch).not.toHaveBeenCalled();
    expect(deps.beginTurn).not.toHaveBeenCalled();
  });

  it('stops at the limits before calling the model', async () => {
    const deps = setup({ beginTurn: vi.fn().mockRejectedValue(new AskError('daily_limit')) });
    const res = await handleAsk(request(), deps);
    expect(res.status).toBe(429);
    expect(await res.json()).toEqual({ error: { code: 'daily_limit' } });
    expect(deps.fetch).not.toHaveBeenCalled();
  });

  it('records a failed call and answers with a code (quota, service down, a bad answer)', async () => {
    for (const [fake, code] of [[gemini({}, 429), 'quota'], [gemini({}, 500), 'unavailable'],
      [Response.json({ candidates: [{ content: { parts: [{ text: 'not json' }] } }] }), 'bad_answer']] as const) {
      const deps = setup({ fetch: vi.fn().mockResolvedValue(fake) });
      const res = await handleAsk(request(), deps);
      expect(res.status).toBe(503);
      expect(await res.json()).toEqual({ error: { code }, conversation_id: conversation });
      expect(vi.mocked(deps.recordTurn).mock.calls[0]![2]).toMatchObject({ error: code, draft: null });
    }
    const deps = setup({ apiKey: '' });
    expect((await handleAsk(request(), deps)).status).toBe(503);
    expect(deps.beginTurn).not.toHaveBeenCalled();
  });

  it('still answers when recording the turn fails', async () => {
    const res = await handleAsk(request(), setup({ recordTurn: vi.fn().mockRejectedValue(new Error('db down')) }));
    expect(res.status).toBe(200);
    expect((await res.json()).turn_id).toBeNull();
  });
});
