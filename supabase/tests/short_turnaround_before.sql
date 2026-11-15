-- PR3 (owner 2026-11-15, REQ §13.190 amended / REQ item 242): the turnaround is a warning on both sides of a ride.
--   (1) edit_ride: a member's ride may start less than the turnaround after the ride before only with
--       `allow_short_turnaround`; the ride before keeps the short gap, its driver gets one `short_turnaround_before`
--       notice; no notice when the ride before is the member's own
--   (2) a new request: with `short_turnaround_before_ask` it waits and names the driver before; answer(yes) places it
--   (3) an edited request stays on its own car with the short gap, asked first; an old browser moves to another car
--   (4) an edit onto hours its car is taken by another ride: `car_change_ask` → needs_confirmation car_taken_choice,
--       nothing changed; `allow_other_car` takes the free car
-- Transactional (begin ... rollback), like the other suites.
begin;
create or replace function pg_temp.expect_err(p_sql text, p_expect text) returns text language plpgsql as $f$
declare v_detail text;
begin
  execute p_sql;
  execute 'set constraints all immediate';
  raise exception 'EXPECTED_FAILURE_MISSING: % (wanted %)', p_sql, p_expect;
exception when others then
  if sqlerrm like 'EXPECTED_FAILURE_MISSING%' then raise; end if;
  get stacked diagnostics v_detail = pg_exception_detail;
  if sqlerrm = p_expect or sqlstate = p_expect then return v_detail; end if;
  raise exception 'wanted %, got % (%): %', p_expect, sqlerrm, sqlstate, p_sql;
end $f$;
create or replace function pg_temp.as_user(p uuid) returns void language sql as $f$
  select set_config('request.jwt.claims', jsonb_build_object('sub', p, 'role', 'authenticated')::text, true);
  select set_config('app.short_turnaround', '', true);   -- a suite is one transaction; a request is one transaction each
$f$;
do $$
declare
  dept uuid:='00000000-0000-0000-0000-000000000001';
  sadran uuid:='00000000-0000-0000-0000-000000000102';
  m1 uuid:='00000000-0000-0000-0000-000000000103';
  m2 uuid:='00000000-0000-0000-0000-000000000104';
  home uuid:='00000000-0000-0000-0000-000000000010';
  dest uuid:='00000000-0000-0000-0000-000000000011';
  typ uuid:='00000000-0000-0000-0000-000000000021';
  car40 uuid:='00000000-0000-0000-0000-000000000040';
  car41 uuid:='00000000-0000-0000-0000-000000000041';
  car42 uuid:='00000000-0000-0000-0000-000000000042';
  w date:=public.current_week_start()+1400;
  day date; pub uuid; res jsonb; q1 uuid; r1 uuid; r2 uuid; r3 uuid; ver int; base jsonb; d0 timestamptz; n int;
begin
  insert into public.weeks(department_id,week_start,phase,open_at,close_at,publish_at)
  values(dept,w,'solving',now()-interval '9 days',now()-interval '8 days',now()-interval '7 days');
  insert into public.siddur_versions(department_id,week_start,snapshot,published_by) values(dept,w,'{}',sadran) returning id into pub;
  perform set_config('app.in_publish','on',true);
  update public.weeks set phase='published',published_version_id=pub,published_days=array[w,w+1,w+2,w+3,w+4,w+5,w+6] where department_id=dept and week_start=w;
  perform set_config('app.in_publish','off',true);
  base := jsonb_build_object('department_id',dept,'week_start',w,'destination_id',dest,'ride_type_id',typ,'origin_id',home,'trip_type','round_trip','adults',1);

  -- ======== (1) a member's move: m2 rides 10-12, m1 moves their 14-16 ride to 12:15 ========
  day:=w+1; d0:=(day+time '00:00') at time zone 'Asia/Jerusalem';
  insert into public.rides(department_id,week_start,car_id,starts_at,ends_at,origin_id,destination_id,driver_id,status,is_pinned,pin_reason,created_by)
    values(dept,w,car40,d0+interval '10 hours',d0+interval '12 hours',home,home,m2,'confirmed',true,'SADRAN_MANUAL',sadran) returning id into r2;
  insert into public.rides(department_id,week_start,car_id,starts_at,ends_at,origin_id,destination_id,driver_id,status,is_pinned,pin_reason,created_by)
    values(dept,w,car40,d0+interval '14 hours',d0+interval '16 hours',home,home,m1,'confirmed',true,'SADRAN_MANUAL',sadran) returning id into r1;
  insert into public.rides(department_id,week_start,car_id,starts_at,ends_at,origin_id,destination_id,driver_id,status,is_pinned,pin_reason,created_by)
    values(dept,w,car40,d0+interval '18 hours',d0+interval '19 hours',home,home,m1,'confirmed',true,'SADRAN_MANUAL',sadran) returning id into r3;
  set constraints all immediate; set constraints all deferred;

  select version into ver from public.rides where id=r1;
  perform pg_temp.as_user(m1);
  perform pg_temp.expect_err(format($q$select public.edit_ride(%L::jsonb,%s)$q$, jsonb_build_object('id',r1,'department_id',dept,'week_start',w,'car_id',car40,
    'starts_at',d0+interval '12 hours 15 minutes','ends_at',d0+interval '14 hours','origin_id',home,'destination_id',home,'driver_id',m1), ver),'23P01');
  -- a real overlap stays refused, also after the yes
  perform pg_temp.as_user(m1);
  perform pg_temp.expect_err(format($q$select public.edit_ride(%L::jsonb,%s)$q$, jsonb_build_object('id',r1,'department_id',dept,'week_start',w,'car_id',car40,
    'starts_at',d0+interval '11 hours 45 minutes','ends_at',d0+interval '14 hours','origin_id',home,'destination_id',home,'driver_id',m1,'allow_short_turnaround',true), ver),'23P01');
  perform pg_temp.as_user(m1);
  perform public.edit_ride(jsonb_build_object('id',r1,'department_id',dept,'week_start',w,'car_id',car40,
    'starts_at',d0+interval '12 hours 15 minutes','ends_at',d0+interval '14 hours','origin_id',home,'destination_id',home,'driver_id',m1,'allow_short_turnaround',true), ver);
  set constraints all immediate; set constraints all deferred;
  assert (select starts_at=d0+interval '12 hours 15 minutes' from public.rides where id=r1), '(1) the ride starts 15 minutes after the ride before';
  assert (select turnaround_override_minutes=15 from public.rides where id=r2), '(1) the ride before keeps a 15-minute gap';
  assert (select count(*) from public.notifications where recipient_id=m2 and event='ride_edited' and data->>'variant'='short_turnaround_before'
          and title_he like '%12:15%' and title_he like '%יונדאי 1%')=1,
    '(1) the driver before gets one short_turnaround_before notice naming the car and the hour';
  assert not exists(select 1 from public.notifications where recipient_id=m1 and data->>'variant' like 'short_turnaround%'), '(1) the mover is not told';
  -- the ride before is the member's own: allowed, nobody told
  select count(*) into n from public.notifications where data->>'variant'='short_turnaround_before';
  select version into ver from public.rides where id=r3;
  perform pg_temp.as_user(m1);
  perform public.edit_ride(jsonb_build_object('id',r3,'department_id',dept,'week_start',w,'car_id',car40,
    'starts_at',d0+interval '14 hours','ends_at',d0+interval '15 hours','origin_id',home,'destination_id',home,'driver_id',m1,'allow_short_turnaround',true), ver);
  set constraints all immediate; set constraints all deferred;
  assert (select starts_at=d0+interval '14 hours' from public.rides where id=r3), '(1) right after my own ride is allowed';
  assert (select count(*) from public.notifications where data->>'variant'='short_turnaround_before')=n, '(1) my own ride before: no notice';

  -- ======== (2) a new request: only car40 could take it, right after m2's 10-12 ride ========
  day:=w+2; d0:=(day+time '00:00') at time zone 'Asia/Jerusalem';
  insert into public.rides(department_id,week_start,car_id,starts_at,ends_at,origin_id,destination_id,driver_id,status,is_pinned,pin_reason,created_by)
    values(dept,w,car40,d0+interval '10 hours',d0+interval '12 hours',home,home,m2,'confirmed',true,'SADRAN_MANUAL',sadran) returning id into r2;
  insert into public.car_maintenance_blocks(car_id,department_id,starts_at,ends_at,reason,created_by)
    select c, dept, d0+interval '6 hours', d0+interval '23 hours', 'SCHEDULED', sadran from unnest(array[car41,car42]) c;
  set constraints all immediate; set constraints all deferred;
  perform pg_temp.as_user(m1);
  res:=public.submit_request(base || jsonb_build_object('depart_at',d0+interval '12 hours 15 minutes','return_at',d0+interval '14 hours',
    'short_turnaround_ask',true,'short_turnaround_before_ask',true));
  assert res->>'status'='waitlisted' and res->'short_turnaround_before'->>'at'='12:00' and (res->'short_turnaround_before'->>'gap')::int=15
    and res->'short_turnaround_before'->>'side'='before'
    and res->'short_turnaround_before'->>'name'=(select full_name from public.profiles where id=m2)
    and not (res->'short_turnaround_before' ? 'recipient_id') and not (res ? 'short_turnaround'),
    format('(2) the request waits and names m2 who rides before, got %s', res);
  q1:=(res->>'request_id')::uuid;
  assert not exists(select 1 from public.notifications where event='waitlisted_request' and data->>'request_id'=q1::text), '(2) the Sadran hears nothing yet';
  perform pg_temp.as_user(m1);
  res:=public.answer_short_turnaround(q1,true);
  set constraints all immediate; set constraints all deferred;
  assert res->>'status'='assigned' and (res->>'car_id')::uuid=car40, format('(2) yes places it on car40, got %s', res);
  assert (select turnaround_override_minutes=15 from public.rides where id=r2), '(2) the ride before keeps the 15-minute gap';
  assert (select count(*) from public.notifications where recipient_id=m2 and data->>'variant'='short_turnaround_before' and data->>'ride_id'=r2::text)=1,
    '(2) the driver before is told once';

  -- ======== (3) an edit stays on its own car: m2 rides 08-10 on car40, m1's 12-14 moves to 10:15 ========
  day:=w+3; d0:=(day+time '00:00') at time zone 'Asia/Jerusalem';
  insert into public.rides(department_id,week_start,car_id,starts_at,ends_at,origin_id,destination_id,driver_id,status,is_pinned,pin_reason,created_by)
    values(dept,w,car40,d0+interval '8 hours',d0+interval '10 hours',home,home,m2,'confirmed',true,'SADRAN_MANUAL',sadran) returning id into r2;
  set constraints all immediate; set constraints all deferred;
  perform pg_temp.as_user(m1);
  res:=public.submit_request(base || jsonb_build_object('depart_at',d0+interval '12 hours','return_at',d0+interval '14 hours'));
  set constraints all immediate; set constraints all deferred;
  q1:=(res->>'request_id')::uuid;
  assert res->>'status'='assigned' and (select r.car_id from public.ride_requests rr join public.rides r on r.id=rr.ride_id where rr.request_id=q1 and r.status<>'cancelled')=car40,
    format('(3) setup: the request sits on car40, got %s', res);
  perform pg_temp.as_user(m1);
  res:=public.submit_request(base || jsonb_build_object('request_id',q1,'expected_version',(select version from public.requests where id=q1),
    'depart_at',d0+interval '10 hours 15 minutes','return_at',d0+interval '12 hours','short_turnaround_ask',true,'short_turnaround_before_ask',true,'car_change_ask',true));
  set constraints all immediate; set constraints all deferred;
  assert res->>'edit_refused' is not null and res->'short_turnaround_before'->>'name'=(select full_name from public.profiles where id=m2),
    format('(3) the edit asks about m2 before anything changes, got %s', res);
  assert (select depart_at=d0+interval '12 hours' from public.requests where id=q1), '(3) nothing changed yet';
  perform pg_temp.as_user(m1);
  res:=public.submit_request(base || jsonb_build_object('request_id',q1,'expected_version',(select version from public.requests where id=q1),
    'depart_at',d0+interval '10 hours 15 minutes','return_at',d0+interval '12 hours','allow_short_turnaround',true,'short_turnaround_before_ask',true,'car_change_ask',true));
  set constraints all immediate; set constraints all deferred;
  assert res->>'status'='assigned' and (select r.car_id from public.ride_requests rr join public.rides r on r.id=rr.ride_id where rr.request_id=q1 and r.status<>'cancelled')=car40,
    format('(3) after the yes the ride stays on car40, got %s', res);
  assert (select turnaround_override_minutes=15 from public.rides where id=r2), '(3) the ride before keeps the 15-minute gap';
  assert (select count(*) from public.notifications where recipient_id=m2 and data->>'variant'='short_turnaround_before' and data->>'ride_id'=r2::text)=1,
    '(3) the driver before is told once';

  -- ======== (4) the booked car is taken by another ride at the new hours ========
  day:=w+4; d0:=(day+time '00:00') at time zone 'Asia/Jerusalem';
  insert into public.rides(department_id,week_start,car_id,starts_at,ends_at,origin_id,destination_id,driver_id,status,is_pinned,pin_reason,created_by)
    values(dept,w,car40,d0+interval '8 hours',d0+interval '11 hours',home,home,m2,'confirmed',true,'SADRAN_MANUAL',sadran) returning id into r2;
  set constraints all immediate; set constraints all deferred;
  perform pg_temp.as_user(m1);
  res:=public.submit_request(base || jsonb_build_object('depart_at',d0+interval '12 hours','return_at',d0+interval '14 hours'));
  set constraints all immediate; set constraints all deferred;
  q1:=(res->>'request_id')::uuid;
  select r.id into r1 from public.ride_requests rr join public.rides r on r.id=rr.ride_id where rr.request_id=q1 and r.status<>'cancelled';
  assert (select car_id from public.rides where id=r1)=car40, '(4) setup: the request sits on car40';
  perform pg_temp.as_user(m1);
  res:=public.submit_request(base || jsonb_build_object('request_id',q1,'expected_version',(select version from public.requests where id=q1),
    'depart_at',d0+interval '10 hours 30 minutes','return_at',d0+interval '12 hours 30 minutes','short_turnaround_ask',true,'short_turnaround_before_ask',true,'car_change_ask',true));
  set constraints all immediate; set constraints all deferred;
  assert res->>'needs_confirmation'='car_taken_choice' and (res->'car_blocker'->>'ride_id')::uuid=r2
    and res->'car_blocker'->>'name'=(select full_name from public.profiles where id=m2) and (res->'car_blocker'->>'mine')::boolean=false
    and res->'other_car'->>'id' is not null and (res->'other_car'->>'id')::uuid<>car40 and (res->'my_ride'->>'id')::uuid=r1,
    format('(4) the edit asks: m2''s ride is in the way, another car is free, got %s', res);
  assert (select depart_at=d0+interval '12 hours' from public.requests where id=q1) and (select status='confirmed' and starts_at=d0+interval '12 hours' from public.rides where id=r1),
    '(4) nothing changed';
  perform pg_temp.as_user(m1);
  res:=public.submit_request(base || jsonb_build_object('request_id',q1,'expected_version',(select version from public.requests where id=q1),
    'depart_at',d0+interval '10 hours 30 minutes','return_at',d0+interval '12 hours 30 minutes','short_turnaround_ask',true,'short_turnaround_before_ask',true,'car_change_ask',true,'allow_other_car',true));
  set constraints all immediate; set constraints all deferred;
  assert res->>'status'='assigned' and (select r.car_id from public.ride_requests rr join public.rides r on r.id=rr.ride_id where rr.request_id=q1 and r.status<>'cancelled')<>car40,
    format('(4) "change car" takes the free car, got %s', res);
  -- an old browser (no car_change_ask) keeps the old behaviour: straight to the free car
  perform pg_temp.as_user(m1);
  res:=public.submit_request(base || jsonb_build_object('depart_at',d0+interval '16 hours','return_at',d0+interval '17 hours'));
  set constraints all immediate; set constraints all deferred;
  q1:=(res->>'request_id')::uuid;
  perform pg_temp.as_user(m1);
  res:=public.submit_request(base || jsonb_build_object('request_id',q1,'expected_version',(select version from public.requests where id=q1),
    'depart_at',d0+interval '13 hours','return_at',d0+interval '14 hours'));
  set constraints all immediate; set constraints all deferred;
  assert res->>'status'='assigned', format('(4) an old browser still gets a car at once, got %s', res);

  -- ======== (5) owner 2026-11-15: asked only when the gap is less than the turnaround ========
  -- only car40 is free; m2 rides 08-10 and 15-16 on it; m1 asks for 10:30-14:30 — exactly the turnaround on both sides
  day:=w+5; d0:=(day+time '00:00') at time zone 'Asia/Jerusalem';
  insert into public.rides(department_id,week_start,car_id,starts_at,ends_at,origin_id,destination_id,driver_id,status,is_pinned,pin_reason,created_by)
    values(dept,w,car40,d0+interval '8 hours',d0+interval '10 hours',home,home,m2,'confirmed',true,'SADRAN_MANUAL',sadran),
          (dept,w,car40,d0+interval '15 hours',d0+interval '16 hours',home,home,m2,'confirmed',true,'SADRAN_MANUAL',sadran);
  insert into public.car_maintenance_blocks(car_id,department_id,starts_at,ends_at,reason,created_by)
    select c, dept, d0+interval '6 hours', d0+interval '23 hours', 'SCHEDULED', sadran from unnest(array[car41,car42]) c;
  set constraints all immediate; set constraints all deferred;
  select count(*) into n from public.notifications where recipient_id=m2 and data->>'variant' like 'short_turnaround%';
  perform pg_temp.as_user(m1);
  res:=public.submit_request(base || jsonb_build_object('depart_at',d0+interval '10 hours 30 minutes','return_at',d0+interval '14 hours 30 minutes',
    'short_turnaround_ask',true,'short_turnaround_before_ask',true));
  set constraints all immediate; set constraints all deferred;
  assert res->>'status'='assigned' and not (res ? 'short_turnaround') and not (res ? 'short_turnaround_before'),
    format('(5) a full turnaround on both sides: placed with no question, got %s', res);
  assert (select count(*) from public.notifications where recipient_id=m2 and data->>'variant' like 'short_turnaround%')=n,
    '(5) nobody is told about a normal gap';

  raise notice 'short_turnaround_before.sql: all assertions passed';
end $$;
rollback;
