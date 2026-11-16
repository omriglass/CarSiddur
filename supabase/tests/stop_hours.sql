-- Stop hours (REQ item 246, LT1): a stop's fixed hour / flexibility / stay through submit_request,
-- the conflict refusal, hours kept when a caller sends only places, the no-change check and the
-- stop ETAs following the one timing rule. Transactional (rolled back). Seeded נבו department,
-- manager …0102 filing for member …0104, destinations חיפה …0011 (home 20 min), בנימינה …0012
-- (home 10 min). A 'solving' week so nothing is auto-placed.
begin;

do $$
declare
  dept uuid := '00000000-0000-0000-0000-000000000001';
  manager uuid := '00000000-0000-0000-0000-000000000102';
  member2 uuid := '00000000-0000-0000-0000-000000000104';
  haifa uuid := '00000000-0000-0000-0000-000000000011';
  binyamina uuid := '00000000-0000-0000-0000-000000000012';
  ride_type uuid := '00000000-0000-0000-0000-000000000021';
  w date := public.current_week_start() + 1449;
  v_depart timestamptz; v_return timestamptz;
  v_result jsonb; req uuid; v_version int; v_eta timestamptz;
  v_payload jsonb;
  v_failed boolean;
  v_detail text;
begin
  insert into public.weeks(department_id, week_start, phase, open_at, close_at, publish_at)
    values (dept, w, 'solving', now() - interval '3 days', now() - interval '2 days', now() - interval '1 day');
  perform set_config('request.jwt.claims', jsonb_build_object('sub', manager, 'role', 'authenticated')::text, true);
  v_depart := (w + 1 + time '08:00') at time zone 'Asia/Jerusalem';
  v_return := (w + 1 + time '18:00') at time zone 'Asia/Jerusalem';

  v_payload := jsonb_build_object(
    'department_id', dept, 'week_start', w, 'requester_id', member2, 'destination_id', haifa, 'ride_type_id', ride_type,
    'trip_type', 'round_trip', 'depart_at', v_depart, 'return_at', v_return);

  -----------------------------------------------------------------------
  -- 1) A stop's fixed hour, flexibility and stay are stored; its ETA is the fixed hour (5 minutes early there).
  -----------------------------------------------------------------------
  v_result := public.submit_request(v_payload || jsonb_build_object('stops', jsonb_build_array(
    jsonb_build_object('leg', 'out', 'place_id', binyamina, 'fixed_anchor', 'arrive',
      'fixed_at', (w + 1 + time '08:15') at time zone 'Asia/Jerusalem', 'flex_minutes', 15, 'stay_minutes', 20))));
  req := (v_result ->> 'request_id')::uuid;
  assert exists (select 1 from public.request_stops where request_id = req and leg = 'out' and fixed_anchor = 'arrive'
                  and fixed_at = (w + 1 + time '08:15') at time zone 'Asia/Jerusalem' and flex_minutes = 15 and stay_minutes = 20),
    'TEST 1 FAILED: the stop hours are stored';
  select eta into v_eta from public.request_stop_etas(req) where leg = 'out';
  assert v_eta = (w + 1 + time '08:15') at time zone 'Asia/Jerusalem', format('TEST 1 FAILED: eta %s', v_eta);
  assert (select (p ->> 'early')::int from jsonb_array_elements(public.request_schedule(req) -> 'points') p where p ->> 'key' = 'out:1') = 5,
    'TEST 1 FAILED: arriving 5 minutes early at the fixed stop';

  -----------------------------------------------------------------------
  -- 2) Saving the same hours again changes nothing (no version bump).
  -----------------------------------------------------------------------
  select version into v_version from public.requests where id = req;
  v_result := public.submit_request(v_payload || jsonb_build_object('request_id', req, 'expected_version', v_version,
    'stops', jsonb_build_array(jsonb_build_object('leg', 'out', 'place_id', binyamina, 'fixed_anchor', 'arrive',
      'fixed_at', (w + 1 + time '08:15') at time zone 'Asia/Jerusalem', 'flex_minutes', 15, 'stay_minutes', 20))));
  assert coalesce((v_result ->> 'unchanged')::boolean, false), format('TEST 2 FAILED: same hours = unchanged (%s)', v_result);
  assert (select version from public.requests where id = req) = v_version, 'TEST 2 FAILED: no version bump';

  -----------------------------------------------------------------------
  -- 3) Only the flexibility changed: a change.
  -----------------------------------------------------------------------
  v_result := public.submit_request(v_payload || jsonb_build_object('request_id', req, 'expected_version', v_version,
    'stops', jsonb_build_array(jsonb_build_object('leg', 'out', 'place_id', binyamina, 'fixed_anchor', 'arrive',
      'fixed_at', (w + 1 + time '08:15') at time zone 'Asia/Jerusalem', 'flex_minutes', 30, 'stay_minutes', 20))));
  assert not coalesce((v_result ->> 'unchanged')::boolean, false), 'TEST 3 FAILED: a new flexibility is a change';
  assert (select flex_minutes from public.request_stops where request_id = req) = 30, 'TEST 3 FAILED: flexibility saved';

  -----------------------------------------------------------------------
  -- 4) A caller that sends only the places (e.g. a Sadran shift) keeps the stored hours.
  -----------------------------------------------------------------------
  perform public.replace_request_stops(req, dept, true, jsonb_build_array(jsonb_build_object('leg', 'out', 'place_id', binyamina)));
  assert exists (select 1 from public.request_stops where request_id = req and fixed_anchor = 'arrive' and flex_minutes = 30 and stay_minutes = 20),
    'TEST 4 FAILED: places-only stops keep the stop hours';

  -----------------------------------------------------------------------
  -- 5) Hours that cannot all be kept are refused and change nothing: Binyamina by 08:05 when the car leaves 08:00 (10-minute drive).
  -----------------------------------------------------------------------
  select version into v_version from public.requests where id = req;
  v_failed := false;
  begin
    perform public.submit_request(v_payload || jsonb_build_object('request_id', req, 'expected_version', v_version,
      'stops', jsonb_build_array(jsonb_build_object('leg', 'out', 'place_id', binyamina, 'fixed_anchor', 'arrive',
        'fixed_at', (w + 1 + time '08:05') at time zone 'Asia/Jerusalem', 'flex_minutes', 0, 'stay_minutes', null))));
  exception when others then
    v_failed := sqlerrm = 'stop_times_conflict';
    get stacked diagnostics v_detail = pg_exception_detail;
  end;
  assert v_failed, 'TEST 5 FAILED: stop_times_conflict';
  assert v_detail::jsonb = jsonb_build_object('key', 'out:1', 'late_by', 5), format('TEST 5 FAILED: detail %s', v_detail);
  assert (select flex_minutes from public.request_stops where request_id = req) = 30, 'TEST 5 FAILED: nothing changed';

  -----------------------------------------------------------------------
  -- 6) The same hour within its flexibility is accepted; the ETA is 08:10 (flexibility used 5).
  -----------------------------------------------------------------------
  v_result := public.submit_request(v_payload || jsonb_build_object('request_id', req, 'expected_version', v_version,
    'stops', jsonb_build_array(jsonb_build_object('leg', 'out', 'place_id', binyamina, 'fixed_anchor', 'arrive',
      'fixed_at', (w + 1 + time '08:05') at time zone 'Asia/Jerusalem', 'flex_minutes', 10, 'stay_minutes', null))));
  select eta into v_eta from public.request_stop_etas(req) where leg = 'out';
  assert v_eta = (w + 1 + time '08:10') at time zone 'Asia/Jerusalem', format('TEST 6 FAILED: eta %s', v_eta);

  -----------------------------------------------------------------------
  -- 7) A return stop with no hour keeps the old ETA rule: when the car leaves it, timed back from home at 18:00.
  -----------------------------------------------------------------------
  select version into v_version from public.requests where id = req;
  v_result := public.submit_request(v_payload || jsonb_build_object('request_id', req, 'expected_version', v_version,
    'stops', jsonb_build_array(jsonb_build_object('leg', 'return', 'place_id', binyamina, 'fixed_anchor', null))));
  select eta into v_eta from public.request_stop_etas(req) where leg = 'return';
  assert v_eta = (w + 1 + time '17:50') at time zone 'Asia/Jerusalem', format('TEST 7 FAILED: eta %s', v_eta);

  -----------------------------------------------------------------------
  -- 8) The checks: a flexibility outside the list, or one without a fixed hour, is refused.
  -----------------------------------------------------------------------
  v_failed := false;
  begin
    update public.request_stops set flex_minutes = 7 where request_id = req;
  exception when check_violation then v_failed := true;
  end;
  assert v_failed, 'TEST 8 FAILED: flexibility outside 0/10/15/30/60';

  raise notice 'stop_hours.sql: all tests passed';
end $$;

rollback;
