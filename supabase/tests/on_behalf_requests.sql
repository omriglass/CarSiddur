-- REQ §13.127 (owner 2026-10-12): a ride filed for someone else, and everyone related may edit it.
-- (a) any approved department member files for another member (`requester_id`; `filed_by` = the filer);
-- (b) the requester, the filer, companions and everyone on a serving ride edit it; withdrawing stays with the
--     requester / filer / Sadran; an unrelated member is refused;
-- (c) a private car takes a request its owner filed (the owner places it, the requester drives); the borrower
--     adds passengers, the owner moves the ride, and a published-day edit goes back on the private car.
-- Transactional (begin ... rollback).
begin;
do $$
declare
  dept uuid := '00000000-0000-0000-0000-000000000001';
  sadran uuid := '00000000-0000-0000-0000-000000000102';
  m1 uuid := '00000000-0000-0000-0000-000000000103';
  m2 uuid := '00000000-0000-0000-0000-000000000104';
  m3 uuid := '00000000-0000-0000-0000-0000000000b3';
  outsider uuid := '00000000-0000-0000-0000-0000000000b4';
  haifa uuid := '00000000-0000-0000-0000-000000000011';
  typ uuid := '00000000-0000-0000-0000-000000000021';
  w date := public.current_week_start() + 1225;
  w2 date := public.current_week_start() + 1232;
  dt timestamptz; dt2 timestamptz; pub uuid; res jsonb; q uuid; q2 uuid; base jsonb; tc uuid; v_ride record;
  v_ver int;
begin
  insert into auth.users(id, email, raw_user_meta_data) values (m3, 'onbehalf-m3@test.local', '{}'), (outsider, 'onbehalf-out@test.local', '{}');
  update public.profiles set approval_status = 'approved', full_name = 'm3' where id = m3;
  update public.profiles set approval_status = 'approved', full_name = 'outsider' where id = outsider;
  insert into public.department_members(department_id, profile_id, role) values (dept, m3, 'member');
  update public.profiles set does_not_drive = false where id in (m1, m2, m3);

  -- an open week for filing and window edits
  insert into public.weeks(department_id,week_start,phase,open_at,close_at,publish_at)
  values(dept,w,'open',now()-interval '1 day',now()+interval '5 days',now()+interval '6 days');
  dt := ((w+1)+time '08:00') at time zone 'Asia/Jerusalem';
  base := jsonb_build_object('department_id',dept,'week_start',w,'ride_type_id',typ,'adults',1,'destination_id',haifa,'trip_type','round_trip');

  -- TEST 1: a plain member files for another member
  perform set_config('request.jwt.claims',jsonb_build_object('sub',m1,'role','authenticated')::text,true);
  res := public.submit_request(base||jsonb_build_object('requester_id',m2,'depart_at',dt,'return_at',dt+interval '3 hours'));
  q := (res->>'request_id')::uuid;
  assert (select requester_id = m2 and filed_by = m1 from public.requests where id = q), 'TEST 1 FAILED: filed for m2 by m1';
  assert public.can_edit_request(q), 'TEST 1 FAILED: the filer may edit';
  raise notice 'TEST 1 PASSED: a member files a request for another member (requester m2, filed_by m1)';

  -- TEST 2: never for someone outside the department
  begin
    perform public.submit_request(base||jsonb_build_object('requester_id',outsider,'depart_at',dt+interval '1 day','return_at',dt+interval '1 day 3 hours'));
    raise exception 'TEST 2 FAILED: filed for a non-member';
  exception when raise_exception then if sqlerrm <> 'not_authorized' then raise; end if;
  end;
  raise notice 'TEST 2 PASSED: filing for someone outside the department is refused';

  -- TEST 3: an unrelated member cannot edit, change companions or see it as editable
  perform set_config('request.jwt.claims',jsonb_build_object('sub',m3,'role','authenticated')::text,true);
  assert not public.can_edit_request(q), 'TEST 3 FAILED: unrelated member sees it editable';
  begin
    perform public.submit_request(base||jsonb_build_object('request_id',q,'expected_version',(select version from public.requests where id=q),
      'depart_at',dt,'return_at',dt+interval '4 hours'));
    raise exception 'TEST 3 FAILED: unrelated member edited';
  exception when raise_exception then if sqlerrm <> 'not_authorized' then raise; end if;
  end;
  begin
    perform public.set_request_companions(q, array[m3]);
    raise exception 'TEST 3 FAILED: unrelated member changed companions';
  exception when raise_exception then if sqlerrm <> 'not_authorized' then raise; end if;
  end;
  raise notice 'TEST 3 PASSED: an unrelated member cannot edit the request';

  -- TEST 4: the filer edits it (the requester stays), then names m3 as a companion
  perform set_config('request.jwt.claims',jsonb_build_object('sub',m1,'role','authenticated')::text,true);
  perform public.submit_request(base||jsonb_build_object('request_id',q,'expected_version',(select version from public.requests where id=q),
    'depart_at',dt,'return_at',dt+interval '4 hours'));
  assert (select requester_id = m2 and return_at = dt+interval '4 hours' from public.requests where id = q), 'TEST 4 FAILED: filer edit stored, requester kept';
  perform public.set_request_companions(q, array[m3]);
  raise notice 'TEST 4 PASSED: the filer edits the request and its companions';

  -- TEST 5: a companion edits it too, but cannot withdraw it; the filer can
  perform set_config('request.jwt.claims',jsonb_build_object('sub',m3,'role','authenticated')::text,true);
  assert public.can_edit_request(q), 'TEST 5 FAILED: companion may edit';
  perform public.submit_request(base||jsonb_build_object('request_id',q,'expected_version',(select version from public.requests where id=q),
    'depart_at',dt+interval '1 hour','return_at',dt+interval '4 hours'));
  assert (select depart_at = dt+interval '1 hour' from public.requests where id = q), 'TEST 5 FAILED: companion edit stored';
  begin
    perform public.withdraw_request(q, (select version from public.requests where id=q));
    raise exception 'TEST 5 FAILED: companion withdrew';
  exception when raise_exception then if sqlerrm <> 'not_authorized' then raise; end if;
  end;
  perform set_config('request.jwt.claims',jsonb_build_object('sub',m1,'role','authenticated')::text,true);
  perform public.withdraw_request(q, (select version from public.requests where id=q));
  assert (select status = 'withdrawn' from public.requests where id = q), 'TEST 5 FAILED: filer withdrew';
  raise notice 'TEST 5 PASSED: a companion edits, only the requester/filer withdraws';

  -- A published week with every shared car in maintenance on the day, and m1's private car.
  insert into public.weeks(department_id,week_start,phase,open_at,close_at,publish_at)
  values(dept,w2,'solving',now()-interval '9 days',now()-interval '8 days',now()-interval '7 days');
  insert into public.siddur_versions(department_id,week_start,snapshot,published_by) values(dept,w2,'{}',sadran) returning id into pub;
  perform set_config('app.in_publish','on',true);
  update public.weeks set phase='published',published_version_id=pub,published_days=array[w2,w2+1,w2+2,w2+3,w2+4,w2+5,w2+6] where department_id=dept and week_start=w2;
  perform set_config('app.in_publish','off',true);
  dt2 := ((w2+1)+time '08:00') at time zone 'Asia/Jerusalem';
  insert into public.car_maintenance_blocks(car_id, starts_at, ends_at, reason, created_by)
  select c.id, dt2 - interval '2 hours', dt2 + interval '14 hours', 'on-behalf test', sadran from public.cars c
  where c.department_id = dept and c.type = 'shared' and c.status = 'active';
  insert into public.cars(department_id, name, license_plate, type, owner_id) values (dept, 'm1 private', 'OB-127', 'temporary', m1) returning id into tc;
  insert into public.car_seat_configs(car_id, adults, child_seats, boosters) values (tc, 5, 0, 0);
  base := base || jsonb_build_object('week_start', w2);

  -- TEST 6: the owner files for m2 (no shared car free → waiting list), then puts it on the private car
  perform set_config('request.jwt.claims',jsonb_build_object('sub',m1,'role','authenticated')::text,true);
  res := public.submit_request(base||jsonb_build_object('requester_id',m2,'depart_at',dt2,'return_at',dt2+interval '3 hours'));
  q := (res->>'request_id')::uuid;
  assert coalesce(res->>'status','') <> 'assigned', format('TEST 6 FAILED: expected no shared car, got %s', res);
  perform set_config('request.jwt.claims',jsonb_build_object('sub',m2,'role','authenticated')::text,true);
  begin
    perform public.place_on_own_car(q, tc);
    raise exception 'TEST 6 FAILED: the requester put it on someone else''s private car';
  exception when raise_exception then if sqlerrm <> 'private_car_owner_only' then raise; end if;
  end;
  perform set_config('request.jwt.claims',jsonb_build_object('sub',m1,'role','authenticated')::text,true);
  res := public.place_on_own_car(q, tc);
  select r.* into v_ride from public.ride_requests rr join public.rides r on r.id = rr.ride_id where rr.request_id = q and r.status <> 'cancelled' limit 1;
  assert v_ride.car_id = tc and v_ride.driver_id = m2, format('TEST 6 FAILED: on the private car, m2 drives (%s)', to_jsonb(v_ride));
  raise notice 'TEST 6 PASSED: the owner puts a request they filed for m2 on their private car; m2 drives';

  -- TEST 7: the owner cannot put a request they did not file (and are not related to) on the car
  perform set_config('request.jwt.claims',jsonb_build_object('sub',m3,'role','authenticated')::text,true);
  res := public.submit_request(base||jsonb_build_object('depart_at',dt2+interval '5 hours','return_at',dt2+interval '7 hours'));
  q2 := (res->>'request_id')::uuid;
  perform set_config('request.jwt.claims',jsonb_build_object('sub',m1,'role','authenticated')::text,true);
  begin
    perform public.place_on_own_car(q2, tc);
    raise exception 'TEST 7 FAILED: owner placed an unrelated request';
  exception when raise_exception then if sqlerrm <> 'not_authorized' then raise; end if;
  end;
  raise notice 'TEST 7 PASSED: the owner cannot take over someone else''s request';

  -- TEST 8: the borrower (driver) adds a passenger on the private car; the owner moves the ride an hour later
  perform set_config('request.jwt.claims',jsonb_build_object('sub',m2,'role','authenticated')::text,true);
  perform public.add_ride_passengers(v_ride.id, (select version from public.rides where id = v_ride.id),
    jsonb_build_array(jsonb_build_object('display_name', 'guest', 'seat_kind', 'adult')));
  assert exists (select 1 from public.ride_passengers where ride_id = v_ride.id and display_name = 'guest'), 'TEST 8 FAILED: passenger added';
  perform set_config('request.jwt.claims',jsonb_build_object('sub',m3,'role','authenticated')::text,true);
  begin
    perform public.add_ride_passengers(v_ride.id, (select version from public.rides where id = v_ride.id),
      jsonb_build_array(jsonb_build_object('display_name', 'guest2', 'seat_kind', 'adult')));
    raise exception 'TEST 8 FAILED: an unrelated member added to a private car';
  exception when raise_exception then if sqlerrm <> 'private_car_owner_only' then raise; end if;
  end;
  perform set_config('request.jwt.claims',jsonb_build_object('sub',m1,'role','authenticated')::text,true);
  select * into v_ride from public.rides where id = v_ride.id;
  perform public.edit_ride(jsonb_build_object('id',v_ride.id,'department_id',dept,'week_start',w2,'car_id',tc,
    'starts_at',v_ride.starts_at+interval '1 hour','ends_at',v_ride.ends_at+interval '1 hour',
    'origin_id',v_ride.origin_id,'destination_id',v_ride.destination_id,'driver_id',v_ride.driver_id), v_ride.version);
  assert (select starts_at = v_ride.starts_at+interval '1 hour' and car_id = tc from public.rides where id = v_ride.id), 'TEST 8 FAILED: owner moved the ride';
  raise notice 'TEST 8 PASSED: the borrower adds passengers, the owner moves the ride, an unrelated member is refused';

  -- TEST 9: a published-day edit of the booked private-car round trip goes back on the private car
  perform set_config('request.jwt.claims',jsonb_build_object('sub',m2,'role','authenticated')::text,true);
  select version into v_ver from public.requests where id = q;
  res := public.submit_request(base||jsonb_build_object('request_id',q,'expected_version',v_ver,'confirm_release',true,
    'depart_at',dt2+interval '1 hour','return_at',dt2+interval '5 hours'));
  assert res->>'status' = 'assigned' and (res->>'car_id')::uuid = tc, format('TEST 9 FAILED: edit back on the private car, got %s', res);
  assert (select r.driver_id = m2 and r.ends_at >= dt2+interval '5 hours' from public.ride_requests rr join public.rides r on r.id = rr.ride_id
          where rr.request_id = q and r.status <> 'cancelled' limit 1), 'TEST 9 FAILED: new times on the private car, m2 drives';
  raise notice 'TEST 9 PASSED: a published-day edit keeps the private car';

  -- TEST 10 (REQ §13.128 c): the private car chosen in the form takes the ride at once — the owner's own, and one the
  -- owner files for someone else; a busy car refuses the submit; someone else's private car is never taken
  perform set_config('request.jwt.claims',jsonb_build_object('sub',m1,'role','authenticated')::text,true);
  res := public.submit_request(base||jsonb_build_object('preferred_car_id',tc,'depart_at',dt2+interval '7 hours','return_at',dt2+interval '8 hours'));
  assert res->>'status' = 'assigned' and (res->>'car_id')::uuid = tc, format('TEST 10 FAILED: own car from the form, got %s', res);
  res := public.submit_request(base||jsonb_build_object('requester_id',m3,'preferred_car_id',tc,'depart_at',dt2+interval '9 hours','return_at',dt2+interval '10 hours'));
  assert res->>'status' = 'assigned' and (res->>'car_id')::uuid = tc, format('TEST 10 FAILED: lent car from the form, got %s', res);
  assert (select r.driver_id = m3 from public.rides r where r.id = (res->>'ride_id')::uuid), 'TEST 10 FAILED: the borrower drives';
  begin
    perform public.submit_request(base||jsonb_build_object('preferred_car_id',tc,'depart_at',dt2+interval '7 hours','return_at',dt2+interval '8 hours'));
    raise exception 'TEST 10 FAILED: a busy private car took a second ride';
  exception when raise_exception then if sqlerrm <> 'own_car_not_free' then raise; end if;
  end;
  perform set_config('request.jwt.claims',jsonb_build_object('sub',m2,'role','authenticated')::text,true);
  res := public.submit_request(base||jsonb_build_object('preferred_car_id',tc,'depart_at',dt2+interval '11 hours','return_at',dt2+interval '12 hours'));
  assert (res->>'car_id') is distinct from tc::text, format('TEST 10 FAILED: a member took someone else''s private car, got %s', res);
  raise notice 'TEST 10 PASSED: the private car chosen in the form takes the ride (own / lent), busy refuses, others never take it';

  -- TEST 12 (REQ §13.129 a): the owner moves someone else's ride (unrelated) onto the private car; the requester is told
  declare v_r record; v_q uuid; v_shared uuid; n int;
  begin
    -- free a shared car on the day for m3's own ride
    delete from public.car_maintenance_blocks where reason = 'on-behalf test'
      and car_id = (select id from public.cars where department_id = dept and type = 'shared' and status = 'active' order by id limit 1);
    perform set_config('request.jwt.claims',jsonb_build_object('sub',m3,'role','authenticated')::text,true);
    res := public.submit_request(base||jsonb_build_object('depart_at',dt2+interval '13 hours','return_at',dt2+interval '14 hours'));
    assert res->>'status' = 'assigned', format('TEST 12 FAILED: setup, got %s', res);
    v_q := (res->>'request_id')::uuid;
    select r.* into v_r from public.rides r where r.id = (res->>'ride_id')::uuid;
    v_shared := v_r.car_id;
    perform set_config('request.jwt.claims',jsonb_build_object('sub',m1,'role','authenticated')::text,true);
    perform public.edit_ride(jsonb_build_object('id',v_r.id,'department_id',dept,'week_start',w2,'car_id',tc,
      'starts_at',v_r.starts_at,'ends_at',v_r.ends_at,'origin_id',v_r.origin_id,'destination_id',v_r.destination_id,'driver_id',v_r.driver_id), v_r.version);
    assert (select car_id = tc and driver_id = m3 from public.rides where id = v_r.id), 'TEST 12 FAILED: moved onto the private car, m3 drives';
    select count(*) into n from public.notifications where recipient_id = m3 and data->>'variant' = 'car_changed' and data->>'ride_id' = v_r.id::text;
    assert n = 1, format('TEST 12 FAILED: the requester is told (%s)', n);
    -- m3 may still resize it on that car afterwards (no new consent needed)
    perform set_config('request.jwt.claims',jsonb_build_object('sub',m3,'role','authenticated')::text,true);
    select * into v_r from public.rides where id = v_r.id;
    perform public.edit_ride(jsonb_build_object('id',v_r.id,'department_id',dept,'week_start',w2,'car_id',tc,
      'starts_at',v_r.starts_at,'ends_at',v_r.ends_at+interval '30 minutes','origin_id',v_r.origin_id,'destination_id',v_r.destination_id,'driver_id',v_r.driver_id), v_r.version);
    -- but m3 (not the owner) cannot move anyone onto it, and m2 cannot move m3's ride onto a car m2 does not own
    perform set_config('request.jwt.claims',jsonb_build_object('sub',m2,'role','authenticated')::text,true);
    select * into v_r from public.rides where id = v_r.id;
    begin
      perform public.edit_ride(jsonb_build_object('id',v_r.id,'department_id',dept,'week_start',w2,'car_id',v_shared,
        'starts_at',v_r.starts_at,'ends_at',v_r.ends_at,'origin_id',v_r.origin_id,'destination_id',v_r.destination_id,'driver_id',v_r.driver_id), v_r.version);
      raise exception 'TEST 12 FAILED: an unrelated member moved the ride';
    exception when raise_exception then if sqlerrm <> 'not_authorized' then raise; end if;
    end;
  end;
  raise notice 'TEST 12 PASSED: the owner moves any ride onto the private car, the requester is told and keeps editing it';
end $$;

-- TEST 13 (REQ §13.129 b): the driver hands their own ride to a driving companion; the request becomes the companion's
-- (filed_by stays), the ride's driver changes, the companion is told; a non-driver or a stranger is refused.
do $$
declare
  dept uuid := '00000000-0000-0000-0000-000000000001';
  sadran uuid := '00000000-0000-0000-0000-000000000102';
  m1 uuid := '00000000-0000-0000-0000-000000000103';
  m2 uuid := '00000000-0000-0000-0000-000000000104';
  haifa uuid := '00000000-0000-0000-0000-000000000011';
  typ uuid := '00000000-0000-0000-0000-000000000021';
  w date := public.current_week_start() + 1239;
  dt timestamptz; pub uuid; res jsonb; q uuid; rid uuid; n int;
begin
  insert into public.weeks(department_id,week_start,phase,open_at,close_at,publish_at)
  values(dept,w,'solving',now()-interval '9 days',now()-interval '8 days',now()-interval '7 days');
  insert into public.siddur_versions(department_id,week_start,snapshot,published_by) values(dept,w,'{}',sadran) returning id into pub;
  perform set_config('app.in_publish','on',true);
  update public.weeks set phase='published',published_version_id=pub,published_days=array[w,w+1,w+2,w+3,w+4,w+5,w+6] where department_id=dept and week_start=w;
  perform set_config('app.in_publish','off',true);
  update public.profiles set does_not_drive = false where id in (m1, m2);
  dt := ((w+2)+time '08:00') at time zone 'Asia/Jerusalem';
  perform set_config('request.jwt.claims',jsonb_build_object('sub',m1,'role','authenticated')::text,true);
  res := public.submit_request(jsonb_build_object('department_id',dept,'week_start',w,'ride_type_id',typ,'adults',2,'destination_id',haifa,
    'trip_type','round_trip','depart_at',dt,'return_at',dt+interval '3 hours','companion_ids',jsonb_build_array(m2)));
  q := (res->>'request_id')::uuid; rid := (res->>'ride_id')::uuid;
  assert rid is not null, format('TEST 13 FAILED: setup, got %s', res);
  perform set_config('request.jwt.claims',jsonb_build_object('sub',m2,'role','authenticated')::text,true);
  begin
    perform public.hand_over_own_ride(rid, (select version from public.rides where id = rid), m2);
    raise exception 'TEST 13 FAILED: a passenger handed over someone else''s ride';
  exception when raise_exception then if sqlerrm <> 'not_authorized' then raise; end if;
  end;
  perform set_config('request.jwt.claims',jsonb_build_object('sub',m1,'role','authenticated')::text,true);
  begin
    perform public.hand_over_own_ride(rid, (select version from public.rides where id = rid), sadran);
    raise exception 'TEST 13 FAILED: handed to someone not on the ride';
  exception when raise_exception then if sqlerrm <> 'handover_driver_invalid' then raise; end if;
  end;
  perform public.hand_over_own_ride(rid, (select version from public.rides where id = rid), m2);
  assert (select requester_id = m2 and filed_by = m1 and adults = 1 from public.requests where id = q), 'TEST 13 FAILED: the request is m2''s, filed by m1, one adult';
  assert not exists (select 1 from public.request_companions where request_id = q), 'TEST 13 FAILED: m2 is no longer a companion';
  assert (select driver_id = m2 and status = 'confirmed' from public.rides where id = rid), 'TEST 13 FAILED: m2 drives the ride';
  select count(*) into n from public.notifications where recipient_id = m2 and data->>'variant' = 'driver_assigned' and data->>'ride_id' = rid::text;
  assert n = 1, format('TEST 13 FAILED: m2 is told (%s)', n);
  assert public.can_edit_request(q), 'TEST 13 FAILED: the leaver may still edit it (filed it)';
  raise notice 'TEST 13 PASSED: the driver hands their ride to a driving companion; strangers / passengers are refused';
end $$;

-- TEST 11 (REQ §13.128 a): a ride of today that already started stays editable from the ride sheet until the day ends:
-- the driver moves its end later and edits its notes. Skipped in the first hours after midnight (the ride would start
-- yesterday).
do $$
declare
  dept uuid := '00000000-0000-0000-0000-000000000001';
  sadran uuid := '00000000-0000-0000-0000-000000000102';
  m1 uuid := '00000000-0000-0000-0000-000000000103';
  haifa uuid := '00000000-0000-0000-0000-000000000011';
  typ uuid := '00000000-0000-0000-0000-000000000021';
  w date := public.current_week_start();
  today date := (now() at time zone 'Asia/Jerusalem')::date;
  dep timestamptz := date_trunc('hour', now()) + interval '2 hours';
  res jsonb; rid uuid; v_ride public.rides%rowtype; pub uuid;
begin
  if (now() at time zone 'Asia/Jerusalem')::time < time '03:00' or (now() at time zone 'Asia/Jerusalem')::time > time '19:00' then
    raise notice 'TEST 11 SKIPPED: too close to midnight'; return;
  end if;
  if not exists (select 1 from public.weeks where department_id = dept and week_start = w) then
    insert into public.weeks(department_id,week_start,phase,open_at,close_at,publish_at)
    values(dept,w,'solving',now()-interval '9 days',now()-interval '8 days',now()-interval '7 days');
  end if;
  insert into public.siddur_versions(department_id,week_start,snapshot,published_by) values(dept,w,'{}',sadran) returning id into pub;
  perform set_config('app.in_publish','on',true);
  update public.weeks set phase='live',published_version_id=pub,published_days=array[w,w+1,w+2,w+3,w+4,w+5,w+6] where department_id=dept and week_start=w;
  perform set_config('app.in_publish','off',true);
  update public.profiles set does_not_drive = false where id = m1;
  perform set_config('request.jwt.claims',jsonb_build_object('sub',m1,'role','authenticated')::text,true);
  res := public.submit_request(jsonb_build_object('department_id',dept,'week_start',w,'ride_type_id',typ,'adults',1,'destination_id',haifa,
    'trip_type','round_trip','depart_at',dep,'return_at',dep+interval '1 hour'));
  rid := (res->>'ride_id')::uuid;
  assert rid is not null, format('TEST 11 FAILED: setup ride, got %s', res);
  -- the ride started two hours ago (moved back by hand, as if time had passed)
  reset role;
  update public.rides set starts_at = starts_at - interval '4 hours', ends_at = ends_at - interval '4 hours',
    blocked_until = blocked_until - interval '4 hours' where id = rid;
  select * into v_ride from public.rides where id = rid;
  assert (v_ride.starts_at at time zone 'Asia/Jerusalem')::date = today and v_ride.starts_at < now(), 'TEST 11 FAILED: setup: started today';
  perform set_config('request.jwt.claims',jsonb_build_object('sub',m1,'role','authenticated')::text,true);
  perform public.edit_ride(jsonb_build_object('id',rid,'department_id',dept,'week_start',w,'car_id',v_ride.car_id,
    'starts_at',v_ride.starts_at,'ends_at',v_ride.ends_at+interval '1 hour','origin_id',v_ride.origin_id,'destination_id',v_ride.destination_id,
    'driver_id',v_ride.driver_id), v_ride.version);
  assert (select ends_at = v_ride.ends_at + interval '1 hour' from public.rides where id = rid), 'TEST 11 FAILED: late return recorded';
  perform public.update_ride_public_notes(rid, (select version from public.rides where id = rid), 'late');
  assert (select notes = 'late' from public.rides where id = rid), 'TEST 11 FAILED: notes on a started ride';
  raise notice 'TEST 11 PASSED: a ride that started today is still moved / noted by its driver';
end $$;
rollback;
