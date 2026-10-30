-- QA run 16 R16B12: a member's edit of a published request's hours moves the named member companions with it; each is
-- told with `outcome_changed` / `time_changed` (old -> new), the editor gets `edit_applied`. Transactional.
begin;
do $$
declare
  dept uuid:='00000000-0000-0000-0000-000000000001';
  sadran uuid:='00000000-0000-0000-0000-000000000102';
  m1 uuid:='00000000-0000-0000-0000-000000000103';
  m2 uuid:='00000000-0000-0000-0000-000000000104';
  dest uuid:='00000000-0000-0000-0000-000000000011';
  typ uuid:='00000000-0000-0000-0000-000000000021';
  car uuid:='00000000-0000-0000-0000-000000000040';
  w date:=public.current_week_start()+1365;
  pub uuid; d timestamptz; q uuid; res jsonb; body text;
begin
  insert into public.weeks(department_id,week_start,phase,open_at,close_at,publish_at)
  values(dept,w,'solving',now()-interval '9 days',now()-interval '8 days',now()-interval '7 days');
  insert into public.siddur_versions(department_id,week_start,snapshot,published_by) values(dept,w,'{}',sadran) returning id into pub;
  perform set_config('app.in_publish','on',true);
  update public.weeks set phase='published',published_version_id=pub,published_days=array[w,w+1,w+2,w+3,w+4,w+5,w+6] where department_id=dept and week_start=w;
  perform set_config('app.in_publish','off',true);
  d:=((w+2)+time '08:00') at time zone 'Asia/Jerusalem';

  -- m1 asks for a ride with m2 as a named companion; it is placed (a published day)
  perform set_config('request.jwt.claims',jsonb_build_object('sub',m1,'role','authenticated')::text,true);
  res:=public.submit_request(jsonb_build_object('department_id',dept,'week_start',w,'destination_id',dest,'ride_type_id',typ,
    'trip_shape','round_trip','depart_at',d,'return_at',d+interval '3 hours','adults',2,'companion_ids',jsonb_build_array(m2)));
  q:=(res->>'request_id')::uuid;
  set constraints all immediate; set constraints all deferred;
  assert (select status::text from public.requests where id=q) in ('assigned','merged'), format('placed first, got %s', res);

  -- m1 moves it an hour later
  res:=public.submit_request(jsonb_build_object('department_id',dept,'week_start',w,'destination_id',dest,'ride_type_id',typ,
    'trip_shape','round_trip','depart_at',d+interval '1 hour','return_at',d+interval '4 hours','adults',2,
    'request_id',q,'expected_version',(select version from public.requests where id=q)));
  set constraints all immediate; set constraints all deferred;
  assert res->>'status'='assigned', format('the edit is placed, got %s', res);
  assert exists (select 1 from public.request_companions where request_id=q and profile_id=m2), 'the companion stays on the request';
  select n.body_he into body from public.notifications n
  where n.recipient_id=m2 and n.event='outcome_changed' and n.data->>'variant'='time_changed' and n.data->>'request_id'=q::text;
  assert body is not null, 'the companion is told the hours changed';
  assert body like '%09:00%', format('the notice says the new hours, got %s', body);
  assert exists (select 1 from public.notifications where recipient_id=m1 and data->>'variant'='edit_applied' and data->>'request_id'=q::text),
    'the editor gets the usual confirmation';
  assert not exists (select 1 from public.notifications where recipient_id=m1 and data->>'variant'='time_changed' and data->>'request_id'=q::text),
    'the editor is not told about their own change';

  set constraints all immediate;
  raise notice 'member_edit_companions.sql: R16B12 assertions passed';
end $$;
rollback;
