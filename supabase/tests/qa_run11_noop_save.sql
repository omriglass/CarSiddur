-- QA run 11 (REQ §13.101 h, R11B1): a save with no changes changes nothing. submit_request returns {ok, unchanged:true}
-- for an update whose effective content equals the stored request: no re-placement, no status/status_reason change, no is_late,
-- no version bump, no notification; the probe paths report `unchanged` too. A real change still behaves as before.
-- Transactional; rolled back at the end. Seeded נבו department, far-future weeks.
begin;
do $$
declare
  dept uuid := '00000000-0000-0000-0000-000000000001';
  manager uuid := '00000000-0000-0000-0000-000000000102';
  member1 uuid := '00000000-0000-0000-0000-000000000103';
  haifa uuid := '00000000-0000-0000-0000-000000000011';
  binyamina uuid := '00000000-0000-0000-0000-000000000012';
  typ uuid := '00000000-0000-0000-0000-000000000021';
  w date := public.current_week_start() + 1400;
  d timestamptz; base jsonb; res jsonb; q uuid; q2 uuid; q3 uuid; row_q public.requests%rowtype; v_rows int; n_before int; n_after int; ride_before uuid; ride_after uuid; pl jsonb; pub uuid;
begin
  insert into public.weeks(department_id, week_start, phase, open_at, close_at, publish_at) values
    (dept, w, 'open', now() - interval '3 days', now() + interval '2 days', now() + interval '3 days');
  perform set_config('request.jwt.claims', jsonb_build_object('sub', member1, 'role', 'authenticated')::text, true);
  d := ((w + 1) + time '07:00') at time zone 'Asia/Jerusalem';
  base := jsonb_build_object('department_id', dept, 'week_start', w, 'destination_id', haifa, 'ride_type_id', typ,
    'trip_type', 'round_trip', 'depart_at', d, 'return_at', d + interval '5 hours', 'adults', 2, 'notes', 'x',
    'flex_depart_late', '01:00:00', 'flex_return_late', '00:30:00',
    'stops', jsonb_build_array(jsonb_build_object('leg', 'out', 'place_id', binyamina), jsonb_build_object('leg', 'out', 'place_text', 'צומת')));
  q := (public.submit_request(base) ->> 'request_id')::uuid;
  select * into row_q from public.requests where id = q;

  -- TEST 1: the same payload again (open week) is a no-op.
  select count(*) into n_before from public.notifications;
  pl := base || jsonb_build_object('request_id', q, 'requester_id', member1, 'expected_version', row_q.version);
  res := public.submit_request(pl);
  assert (res ->> 'unchanged')::boolean and (res ->> 'ok')::boolean, format('TEST 1 FAILED: a save with no changes is unchanged: %s', res);
  assert (select version from public.requests where id = q) = row_q.version, 'TEST 1 FAILED: no version bump';
  assert (select updated_at from public.requests where id = q) = row_q.updated_at, 'TEST 1 FAILED: the row is untouched';
  select count(*) into n_after from public.notifications;
  assert n_after = n_before, 'TEST 1 FAILED: no notification';
  -- the stored values written back by the form (interval spelled differently, empty strings, notes kept) stay a no-op
  res := public.submit_request(pl || jsonb_build_object('flex_depart_late', '1 hour', 'flex_depart_early', '', 'destination_text', '', 'origin_text', null));
  assert (res ->> 'unchanged')::boolean, format('TEST 1b FAILED: normalised spellings are a no-op: %s', res);

  -- TEST 2: probe_only reports it; a stale version still raises.
  res := public.submit_request(pl || jsonb_build_object('probe_only', true));
  assert (res ->> 'unchanged')::boolean and not (res ->> 'would_lose_booking')::boolean, format('TEST 2 FAILED: probe reports unchanged: %s', res);
  begin
    perform public.submit_request(pl || jsonb_build_object('expected_version', row_q.version + 5));
    assert false, 'TEST 2 FAILED: a stale version must still raise';
  exception when others then assert sqlerrm like '%stale%' or sqlstate = 'P0409', format('TEST 2 FAILED: unexpected error %s', sqlerrm); end;

  -- TEST 3: a real change is not a no-op (time, notes, stops, one more adult).
  res := public.submit_request(pl || jsonb_build_object('depart_at', d + interval '15 minutes'));
  assert not coalesce((res ->> 'unchanged')::boolean, false), 'TEST 3 FAILED: a time change saves';
  select * into row_q from public.requests where id = q;
  assert row_q.depart_at = d + interval '15 minutes' and row_q.version > 1, 'TEST 3 FAILED: the new time is stored';
  pl := base || jsonb_build_object('request_id', q, 'requester_id', member1, 'expected_version', row_q.version, 'depart_at', d + interval '15 minutes');
  res := public.submit_request(pl || jsonb_build_object('stops', jsonb_build_array(jsonb_build_object('leg', 'out', 'place_text', 'צומת'), jsonb_build_object('leg', 'out', 'place_id', binyamina))));
  assert not coalesce((res ->> 'unchanged')::boolean, false), 'TEST 3 FAILED: reordered stops save';
  select * into row_q from public.requests where id = q;
  pl := pl || jsonb_build_object('expected_version', row_q.version, 'stops', jsonb_build_array(jsonb_build_object('leg', 'out', 'place_text', 'צומת'), jsonb_build_object('leg', 'out', 'place_id', binyamina)));
  res := public.submit_request(pl || jsonb_build_object('adults', 3));
  assert not coalesce((res ->> 'unchanged')::boolean, false), 'TEST 3 FAILED: a people count change saves';
  select * into row_q from public.requests where id = q;
  pl := pl || jsonb_build_object('expected_version', row_q.version, 'adults', 3);
  res := public.submit_request(pl || jsonb_build_object('notes', 'y'));
  assert not coalesce((res ->> 'unchanged')::boolean, false), 'TEST 3 FAILED: a notes change saves';
  select * into row_q from public.requests where id = q;
  res := public.submit_request(pl || jsonb_build_object('expected_version', row_q.version, 'notes', 'y'));
  assert (res ->> 'unchanged')::boolean, format('TEST 3 FAILED: and the new state is again a no-op: %s', res);

  -- TEST 4: a waitlisted request on a published week stays waitlisted (reason, version, notifications untouched).
  insert into public.siddur_versions(department_id, week_start, snapshot, published_by) values (dept, w, '{}', manager) returning id into pub;
  perform set_config('app.in_publish', 'on', true);
  update public.weeks set phase = 'published', published_version_id = pub, published_at = now(), published_days = array[(w + 1)], close_at = now() - interval '1 hour'
    where department_id = dept and week_start = w;
  perform set_config('app.in_publish', 'off', true);
  perform set_config('app.system_status_transition', 'on', true);
  update public.requests set status = 'waitlisted', status_reason = 'WAITLISTED_NO_CAR' where id = q;
  select * into row_q from public.requests where id = q;
  select count(*) into n_before from public.notifications;
  pl := pl || jsonb_build_object('expected_version', row_q.version, 'notes', 'y');
  res := public.submit_request(pl);
  assert (res ->> 'unchanged')::boolean and res ->> 'status' = 'waitlisted', format('TEST 4 FAILED: waitlisted no-op on a published week: %s', res);
  select * into row_q from public.requests where id = q;
  assert row_q.status = 'waitlisted' and row_q.status_reason = 'WAITLISTED_NO_CAR' and not row_q.is_late, 'TEST 4 FAILED: status, reason and is_late untouched';
  select count(*) into n_after from public.notifications;
  assert n_after = n_before, 'TEST 4 FAILED: no notification (no waiting-list notice, no late notice)';

  -- TEST 5: a submitted request on a published week is not placed by a no-op save either.
  update public.requests set status = 'submitted', status_reason = null where id = q;
  select * into row_q from public.requests where id = q;
  res := public.submit_request(pl || jsonb_build_object('expected_version', row_q.version));
  assert (res ->> 'unchanged')::boolean, format('TEST 5 FAILED: %s', res);
  assert (select status from public.requests where id = q) = 'submitted'
    and not exists (select 1 from public.ride_requests where request_id = q), 'TEST 5 FAILED: still submitted, no ride';
  perform set_config('app.system_status_transition', 'off', true);

  -- TEST 6: an assigned request on a published week keeps its ride and car on a no-op save.
  base := base || jsonb_build_object('depart_at', d + interval '1 day', 'return_at', d + interval '1 day 4 hours');
  delete from public.request_stops where request_id = q;
  update public.weeks set published_days = array[(w + 1), (w + 2)] where department_id = dept and week_start = w;
  res := public.submit_request(base - 'stops');
  q2 := (res ->> 'request_id')::uuid;
  assert res ->> 'status' = 'assigned', format('TEST 6 setup FAILED: expected a placed request, got %s', res);
  select * into row_q from public.requests where id = q2;
  select rr.ride_id into ride_before from public.ride_requests rr where rr.request_id = q2 limit 1;
  select count(*) into n_before from public.notifications;
  pl := (base - 'stops') || jsonb_build_object('request_id', q2, 'requester_id', member1, 'expected_version', row_q.version);
  res := public.submit_request(pl || jsonb_build_object('probe_only', true));
  assert (res ->> 'unchanged')::boolean and not (res ->> 'would_lose_booking')::boolean, format('TEST 6 FAILED: probe on an assigned no-op: %s', res);
  res := public.submit_request(pl);
  assert (res ->> 'unchanged')::boolean and res ->> 'status' = 'assigned', format('TEST 6 FAILED: %s', res);
  select rr.ride_id into ride_after from public.ride_requests rr where rr.request_id = q2 limit 1;
  assert ride_after = ride_before and (select status from public.requests where id = q2) = 'assigned', 'TEST 6 FAILED: same ride, still assigned';
  assert (select status_reason from public.requests where id = q2) is not distinct from row_q.status_reason
    and (select version from public.requests where id = q2) = row_q.version, 'TEST 6 FAILED: reason and version untouched';
  select count(*) into n_after from public.notifications;
  assert n_after = n_before, 'TEST 6 FAILED: no notification';
  -- a real change (another day) on the assigned request is not a no-op (it re-places or asks, as before)
  res := public.submit_request(pl || jsonb_build_object('probe_only', true, 'depart_at', d + interval '1 day 15 minutes'));
  assert not (res ->> 'unchanged')::boolean, 'TEST 6 FAILED: a real change is not unchanged';

  -- TEST 7: a placement-neutral edit (notes, public description, preferred car as a wish) on the assigned request is stored in place.
  select * into row_q from public.requests where id = q2;
  select count(*) into n_before from public.notifications where event = 'request_changed';
  pl := pl || jsonb_build_object('expected_version', row_q.version, 'notes', 'new note', 'ride_description', 'public text', 'preferred_car_id', '00000000-0000-0000-0000-000000000040');
  res := public.submit_request(pl || jsonb_build_object('probe_only', true));
  assert (res ->> 'placement_neutral')::boolean and not (res ->> 'would_lose_booking')::boolean, format('TEST 7 FAILED: probe: %s', res);
  res := public.submit_request(pl);
  assert (res ->> 'placement_neutral')::boolean and res ->> 'status' = 'assigned' and not coalesce((res ->> 'needs_confirmation') is not null, false), format('TEST 7 FAILED: %s', res);
  select * into row_q from public.requests where id = q2;
  select rr.ride_id into ride_after from public.ride_requests rr where rr.request_id = q2 limit 1;
  assert row_q.notes = 'new note' and row_q.ride_description = 'public text' and row_q.preferred_car_id = '00000000-0000-0000-0000-000000000040', 'TEST 7 FAILED: fields stored';
  assert ride_after = ride_before and row_q.status = 'assigned' and row_q.status_reason is not distinct from 'AUTO_APPROVED_FREE_CAR', 'TEST 7 FAILED: still on the same ride, status and reason untouched';
  -- and the same payload again is now a plain no-op; a time change on top is placement-relevant
  res := public.submit_request(pl || jsonb_build_object('expected_version', row_q.version));
  assert (res ->> 'unchanged')::boolean, format('TEST 7 FAILED: %s', res);
  res := public.submit_request(pl || jsonb_build_object('expected_version', row_q.version, 'probe_only', true, 'depart_at', d + interval '1 day 15 minutes'));
  assert not (res ->> 'placement_neutral')::boolean, 'TEST 7 FAILED: a time change is placement-relevant';
end $$;
rollback;
