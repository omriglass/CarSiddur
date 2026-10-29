-- Hardening 2026-10-29 (two Sadrans on one week): apply_solver_result refuses a payload solved on an older state.
--   (a) solver_state_fingerprint: the week's managers only (cross-department refusal: department_isolation.sql)
--   (b) a payload carrying the current state_fingerprint applies
--   (c) after any change to the week's requests/rides, the same fingerprint is refused as stale_input (P0409) and
--       nothing of the payload is applied
--   (d) a payload without state_fingerprint keeps the old behaviour (no check)
-- Transactional (begin ... rollback).
begin;
do $$
declare
  dept uuid:='00000000-0000-0000-0000-000000000001';
  sadran uuid:='00000000-0000-0000-0000-000000000102';
  m1 uuid:='00000000-0000-0000-0000-000000000103';
  home uuid:='00000000-0000-0000-0000-000000000010';
  dest uuid:='00000000-0000-0000-0000-000000000011';
  typ uuid:='00000000-0000-0000-0000-000000000021';
  carA uuid:='00000000-0000-0000-0000-000000000040';
  w date:=public.current_week_start()+1358;
  dt timestamptz; q1 uuid; fp text; res jsonb; n int;
  empty_payload jsonb := jsonb_build_object('mode','remaining','rides','[]'::jsonb,'request_statuses','[]'::jsonb,
    'policy_version_id','00000000-0000-0000-0000-000000000031','solver_version','test','input_hash','stale-input-test',
    'started_at',now()::text,'finished_at',now()::text,'duration_ms',0,'summary','{}'::jsonb);
begin
  dt:=((w+2)+time '08:00') at time zone 'Asia/Jerusalem';
  insert into public.weeks(department_id,week_start,phase,open_at,close_at,publish_at)
  values(dept,w,'solving',now()-interval '9 days',now()-interval '8 days',now()+interval '1 day');
  insert into public.requests(department_id,week_start,requester_id,filed_by,destination_id,ride_type_id,depart_at,return_at,trip_shape,status)
    values(dept,w,m1,m1,dest,typ,dt,dt+interval '4 hours','round_trip','submitted') returning id into q1;

  -- (a) a plain member is refused
  perform set_config('request.jwt.claims',jsonb_build_object('sub',m1,'role','authenticated')::text,true);
  begin
    perform public.solver_state_fingerprint(dept,w);
    raise exception 'member fingerprint unexpectedly allowed';
  exception when others then
    assert sqlerrm='not_authorized', format('(a) a member is refused, got %s', sqlerrm);
  end;

  -- (b) current fingerprint: applies (one ride for q1)
  perform set_config('request.jwt.claims',jsonb_build_object('sub',sadran,'role','authenticated')::text,true);
  fp := public.solver_state_fingerprint(dept,w);
  assert fp is not null, '(b) fingerprint present';
  res := public.apply_solver_result(dept,w, empty_payload || jsonb_build_object('state_fingerprint',fp,
    'rides', jsonb_build_array(jsonb_build_object('car_id',carA,'starts_at',dt,'ends_at',dt+interval '4 hours',
      'origin_id',home,'destination_id',home,'driver_id',m1,
      'served',jsonb_build_array(jsonb_build_object('request_id',q1,'role','driver','leg','both','car_mode','keep'))))));
  assert (res->>'inserted')::int = 1, format('(b) current fingerprint applies, got %s', res);

  -- (c) the week changed since (the apply above): the old fingerprint is stale; nothing applied
  select count(*) into n from public.rides where department_id=dept and week_start=w and status<>'cancelled';
  begin
    perform public.apply_solver_result(dept,w, empty_payload || jsonb_build_object('state_fingerprint',fp,
      'rides', jsonb_build_array(jsonb_build_object('car_id',carA,'starts_at',dt+interval '6 hours','ends_at',dt+interval '8 hours',
        'origin_id',home,'destination_id',home,'driver_id',m1,'served','[]'::jsonb))));
    raise exception 'stale payload unexpectedly applied';
  exception when others then
    assert sqlstate='P0409' and sqlerrm='stale_input', format('(c) stale fingerprint refused, got %s %s', sqlstate, sqlerrm);
  end;
  assert (select count(*) from public.rides where department_id=dept and week_start=w and status<>'cancelled') = n,
    '(c) nothing of the stale payload applied';

  -- (d) no fingerprint: no check (older clients, the regression's own runs)
  res := public.apply_solver_result(dept,w, empty_payload);
  assert (res->>'inserted')::int = 0, format('(d) payload without a fingerprint applies, got %s', res);
end $$;
rollback;
