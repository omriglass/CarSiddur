-- REQ §13.190 (TODO TG1): on a published day a member may leave less than the turnaround before the car's next
-- ride, after "תיאמתם עם X…?".
--   * edit_ride (a member's move/resize): refused without `allow_short_turnaround`; with it the ride keeps the short
--     gap (turnaround_override_minutes) and X gets one `ride_edited` notice, variant short_turnaround; a real overlap
--     and the turnaround after the ride before stay refused
--   * submit_request `short_turnaround_ask`: when only the next ride's turnaround stands in the way the request waits,
--     the result names X and the hour, and the Sadran hears nothing yet; answer_short_turnaround(yes) places it with
--     the gap and tells X, (no) waitlists it the usual way
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
  w date:=public.current_week_start()+1302;
  day date; pub uuid; res jsonb; q1 uuid; q2 uuid; r1 uuid; r2 uuid; ver int;
  at18 timestamptz;
begin
  insert into public.weeks(department_id,week_start,phase,open_at,close_at,publish_at)
  values(dept,w,'solving',now()-interval '9 days',now()-interval '8 days',now()-interval '7 days');
  insert into public.siddur_versions(department_id,week_start,snapshot,published_by) values(dept,w,'{}',sadran) returning id into pub;
  perform set_config('app.in_publish','on',true);
  update public.weeks set phase='published',published_version_id=pub,published_days=array[w,w+1,w+2,w+3,w+4,w+5,w+6] where department_id=dept and week_start=w;
  perform set_config('app.in_publish','off',true);

  -- ======== (1) a member's move: m1's ride 08-10 to 16:00-17:45, m2 takes the car at 18:00 ========
  day:=w+1; at18:=(day+time '18:00') at time zone 'Asia/Jerusalem';
  insert into public.requests(department_id,week_start,requester_id,filed_by,destination_id,ride_type_id,depart_at,return_at,trip_shape,status,origin_id)
    values(dept,w,m1,m1,dest,typ,(day+time '08:00') at time zone 'Asia/Jerusalem',(day+time '10:00') at time zone 'Asia/Jerusalem','round_trip','assigned',home) returning id into q1;
  insert into public.rides(department_id,week_start,car_id,starts_at,ends_at,origin_id,destination_id,driver_id,status,is_pinned,pin_reason,created_by)
    values(dept,w,car40,(day+time '08:00') at time zone 'Asia/Jerusalem',(day+time '10:00') at time zone 'Asia/Jerusalem',home,home,m1,'confirmed',true,'SADRAN_MANUAL',sadran) returning id into r1;
  insert into public.ride_requests(ride_id,request_id,role,leg,car_mode) values(r1,q1,'driver','both','keep');
  insert into public.requests(department_id,week_start,requester_id,filed_by,destination_id,ride_type_id,depart_at,return_at,trip_shape,status,origin_id)
    values(dept,w,m2,m2,dest,typ,at18,at18+interval '2 hours','round_trip','assigned',home) returning id into q2;
  insert into public.rides(department_id,week_start,car_id,starts_at,ends_at,origin_id,destination_id,driver_id,status,is_pinned,pin_reason,created_by)
    values(dept,w,car40,at18,at18+interval '2 hours',home,home,m2,'confirmed',true,'SADRAN_MANUAL',sadran) returning id into r2;
  insert into public.ride_requests(ride_id,request_id,role,leg,car_mode) values(r2,q2,'driver','both','keep');
  set constraints all immediate; set constraints all deferred;

  select version into ver from public.rides where id=r1;
  perform pg_temp.as_user(m1);
  perform pg_temp.expect_err(format($q$select public.edit_ride(%L::jsonb,%s)$q$, jsonb_build_object('id',r1,'department_id',dept,'week_start',w,'car_id',car40,
    'starts_at',at18-interval '105 minutes','ends_at',at18-interval '15 minutes','origin_id',home,'destination_id',home,'driver_id',m1), ver),'23P01');
  perform pg_temp.as_user(m1);
  perform pg_temp.expect_err(format($q$select public.edit_ride(%L::jsonb,%s)$q$, jsonb_build_object('id',r1,'department_id',dept,'week_start',w,'car_id',car40,
    'starts_at',at18-interval '105 minutes','ends_at',at18+interval '15 minutes','origin_id',home,'destination_id',home,'driver_id',m1,'allow_short_turnaround',true), ver),'23P01');
  perform pg_temp.as_user(m1);
  perform public.edit_ride(jsonb_build_object('id',r1,'department_id',dept,'week_start',w,'car_id',car40,
    'starts_at',at18-interval '105 minutes','ends_at',at18-interval '15 minutes','origin_id',home,'destination_id',home,'driver_id',m1,'allow_short_turnaround',true), ver);
  set constraints all immediate; set constraints all deferred;
  assert (select ends_at=at18-interval '15 minutes' and turnaround_override_minutes=15 from public.rides where id=r1), '(1) the move keeps a 15-minute gap';
  assert (select count(*) from public.notifications where recipient_id=m2 and event='ride_edited' and data->>'variant'='short_turnaround')=1,
    '(1) the next ride''s driver gets one short_turnaround notice';
  assert not exists(select 1 from public.notifications where recipient_id=m1 and data->>'variant'='short_turnaround'), '(1) the mover is not told';
  -- a gap of 0 is fine too; starting inside the turnaround after the ride before is not
  select version into ver from public.rides where id=r1;
  perform pg_temp.as_user(m1);
  perform public.edit_ride(jsonb_build_object('id',r1,'department_id',dept,'week_start',w,'car_id',car40,
    'starts_at',at18-interval '2 hours','ends_at',at18,'origin_id',home,'destination_id',home,'driver_id',m1,'allow_short_turnaround',true), ver);
  set constraints all immediate; set constraints all deferred;
  assert (select turnaround_override_minutes=0 from public.rides where id=r1), '(1) ending right at 18:00 is allowed';
  select version into ver from public.rides where id=r1;
  perform pg_temp.as_user(m1);
  perform pg_temp.expect_err(format($q$select public.edit_ride(%L::jsonb,%s)$q$, jsonb_build_object('id',r1,'department_id',dept,'week_start',w,'car_id',car40,
    'starts_at',at18+interval '2 hours 15 minutes','ends_at',at18+interval '3 hours','origin_id',home,'destination_id',home,'driver_id',m1,'allow_short_turnaround',true), ver),'23P01');

  -- ======== (2) a new request: only car40 could take it, and only with a short gap before m2's 18:00 ride ========
  day:=w+2; at18:=(day+time '18:00') at time zone 'Asia/Jerusalem';
  insert into public.requests(department_id,week_start,requester_id,filed_by,destination_id,ride_type_id,depart_at,return_at,trip_shape,status,origin_id)
    values(dept,w,m2,m2,dest,typ,at18,at18+interval '2 hours','round_trip','assigned',home) returning id into q2;
  insert into public.rides(department_id,week_start,car_id,starts_at,ends_at,origin_id,destination_id,driver_id,status,is_pinned,pin_reason,created_by)
    values(dept,w,car40,at18,at18+interval '2 hours',home,home,m2,'confirmed',true,'SADRAN_MANUAL',sadran) returning id into r2;
  insert into public.ride_requests(ride_id,request_id,role,leg,car_mode) values(r2,q2,'driver','both','keep');
  insert into public.car_maintenance_blocks(car_id,department_id,starts_at,ends_at,reason,created_by)
    select c, dept, (day+time '06:00') at time zone 'Asia/Jerusalem', (day+time '23:00') at time zone 'Asia/Jerusalem', 'SCHEDULED', sadran from unnest(array[car41,car42]) c;
  set constraints all immediate; set constraints all deferred;

  perform pg_temp.as_user(m1);
  res:=public.submit_request(jsonb_build_object('department_id',dept,'week_start',w,'destination_id',dest,'ride_type_id',typ,'origin_id',home,
    'depart_at',at18-interval '3 hours','return_at',at18-interval '15 minutes','trip_type','round_trip','adults',1,'short_turnaround_ask',true));
  assert res->>'status'='waitlisted' and res->'short_turnaround'->>'at'='18:00' and (res->'short_turnaround'->>'gap')::int=15
    and res->'short_turnaround'->>'name'=(select full_name from public.profiles where id=m2) and not (res->'short_turnaround' ? 'recipient_id'),
    format('(2) the request waits and names m2 at 18:00, got %s', res);
  q1:=(res->>'request_id')::uuid;
  assert not exists(select 1 from public.notifications where event='waitlisted_request' and data->>'request_id'=q1::text), '(2) the Sadran hears nothing yet';
  perform pg_temp.as_user(m1);
  res:=public.answer_short_turnaround(q1, true);
  set constraints all immediate; set constraints all deferred;
  assert res->>'status'='assigned' and (res->>'car_id')::uuid=car40, format('(2) yes places it on car40, got %s', res);
  assert (select turnaround_override_minutes=15 from public.rides where id=(res->>'ride_id')::uuid), '(2) the new ride keeps the 15-minute gap';
  assert (select count(*) from public.notifications where recipient_id=m2 and event='ride_edited' and data->>'variant'='short_turnaround' and data->>'ride_id'=r2::text)=1,
    '(2) m2 is told';

  -- ======== (3) "no": waitlisted the usual way; only the requester (or a related member / the Sadran) answers ========
  perform pg_temp.as_user(m2);
  res:=public.submit_request(jsonb_build_object('department_id',dept,'week_start',w,'destination_id',dest,'ride_type_id',typ,'origin_id',home,
    'depart_at',at18-interval '6 hours','return_at',at18-interval '3 hours 15 minutes','trip_type','round_trip','adults',1,'short_turnaround_ask',true));
  q1:=(res->>'request_id')::uuid;
  assert res->>'status'='waitlisted' and res->'short_turnaround'->>'at'='15:00' and res->'short_turnaround'->>'name'=(select full_name from public.profiles where id=m1),
    format('(3) names m1''s 15:00 ride placed in (2), got %s', res);
  perform pg_temp.as_user(m1);
  perform pg_temp.expect_err(format($q$select public.answer_short_turnaround(%L,false)$q$, q1),'not_authorized');
  perform pg_temp.as_user(m2);
  res:=public.answer_short_turnaround(q1, false);
  assert res->>'status'='waitlisted' and not (res ? 'short_turnaround'), format('(3) no = the usual waiting list, got %s', res);
  assert exists(select 1 from public.notifications where event='waitlisted_request' and data->>'request_id'=q1::text), '(3) now the Sadran is told';
  perform pg_temp.as_user(m2);
  perform public.withdraw_request(q1, (select version from public.requests where id=q1));

  -- ======== (4) the next ride is the member's own: placed with the short gap, nobody asked ========
  perform pg_temp.as_user(m1);
  res:=public.submit_request(jsonb_build_object('department_id',dept,'week_start',w,'destination_id',dest,'ride_type_id',typ,'origin_id',home,
    'depart_at',at18-interval '6 hours','return_at',at18-interval '3 hours 15 minutes','trip_type','round_trip','adults',1,'short_turnaround_ask',true));
  assert res->>'status'='assigned' and not (res ? 'short_turnaround'), format('(4) my own next ride: placed at once, got %s', res);
  set constraints all immediate; set constraints all deferred;
  -- ======== (5) TG2: a multi-day request whose last day ends 15 minutes before m2's 18:00 ride ========
  day:=w+4; at18:=(day+time '18:00') at time zone 'Asia/Jerusalem';
  insert into public.requests(department_id,week_start,requester_id,filed_by,destination_id,ride_type_id,depart_at,return_at,trip_shape,status,origin_id)
    values(dept,w,m2,m2,dest,typ,at18,at18+interval '2 hours','round_trip','assigned',home) returning id into q2;
  insert into public.rides(department_id,week_start,car_id,starts_at,ends_at,origin_id,destination_id,driver_id,status,is_pinned,pin_reason,created_by)
    values(dept,w,car40,at18,at18+interval '2 hours',home,home,m2,'confirmed',true,'SADRAN_MANUAL',sadran) returning id into r2;
  insert into public.ride_requests(ride_id,request_id,role,leg,car_mode) values(r2,q2,'driver','both','keep');
  insert into public.car_maintenance_blocks(car_id,department_id,starts_at,ends_at,reason,created_by)
    select c, dept, ((w+3)+time '06:00') at time zone 'Asia/Jerusalem', (day+time '23:00') at time zone 'Asia/Jerusalem', 'SCHEDULED', sadran from unnest(array[car41,car42]) c;
  set constraints all immediate; set constraints all deferred;
  perform pg_temp.as_user(m1);
  res:=public.submit_series_request(jsonb_build_object('department_id',dept,'week_start',w,'destination_id',dest,'ride_type_id',typ,'origin_id',home,
    'depart_at',((w+3)+time '09:00') at time zone 'Asia/Jerusalem','return_at',at18-interval '15 minutes','trip_type','round_trip','adults',1,
    'short_turnaround_ask',true));
  assert res->>'status'='waitlisted' and res->'short_turnaround'->>'at'='18:00' and (res->'short_turnaround'->>'gap')::int=15
    and res->'short_turnaround'->>'name'=(select full_name from public.profiles where id=m2), format('(5) the series waits and names m2, got %s', res);
  q1:=(res->'request_ids'->>0)::uuid;
  assert not exists(select 1 from public.notifications where event='waitlisted_request' and data->>'series_id'=res->>'series_id'), '(5) the Sadran hears nothing yet';
  perform pg_temp.as_user(m1);
  res:=public.answer_short_turnaround(q1, true);
  set constraints all immediate; set constraints all deferred;
  assert res->>'status'='assigned' and (res->>'car_id')::uuid=car40, format('(5) yes places the series on car40, got %s', res);
  assert (select turnaround_override_minutes from public.rides r join public.requests q on q.series_id=r.series_id
          where q.id=q1 and r.ends_at=at18-interval '15 minutes' and r.status<>'cancelled')=15, '(5) the last day keeps the 15-minute gap';
  assert (select count(*) from public.notifications where recipient_id=m2 and event='ride_edited' and data->>'variant'='short_turnaround' and data->>'ride_id'=r2::text)=1,
    '(5) m2 is told';
  raise notice 'short_turnaround.sql: all assertions passed';
end $$;
rollback;
