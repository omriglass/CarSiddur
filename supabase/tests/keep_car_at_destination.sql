-- REQ §13.126 g (owner 2026-10-11): "הרכב זמין לשימוש ביעד". A member-driven round trip filed as a two-way הקפצה with
-- keep_car_at_destination: on a published day both legs land on ONE car, connected (the requester drives both, the car
-- waits at the destination), and someone else's trip that starts and ends there may use the car in between.
-- Transactional (begin ... rollback).
begin;
do $$
declare
  dept uuid := '00000000-0000-0000-0000-000000000001';
  sadran uuid := '00000000-0000-0000-0000-000000000102';
  m1 uuid := '00000000-0000-0000-0000-000000000103';
  m2 uuid := '00000000-0000-0000-0000-000000000104';
  home uuid := '00000000-0000-0000-0000-000000000010';
  haifa uuid := '00000000-0000-0000-0000-000000000011';
  binyamina uuid := '00000000-0000-0000-0000-000000000012';
  typ uuid := '00000000-0000-0000-0000-000000000021';
  w date := public.current_week_start() + 1218;
  dt timestamptz; pub uuid; res jsonb; q uuid; v_car uuid; v_out record; v_ret record; base jsonb;
begin
  insert into public.weeks(department_id,week_start,phase,open_at,close_at,publish_at)
  values(dept,w,'solving',now()-interval '9 days',now()-interval '8 days',now()-interval '7 days');
  insert into public.siddur_versions(department_id,week_start,snapshot,published_by) values(dept,w,'{}',sadran) returning id into pub;
  perform set_config('app.in_publish','on',true);
  update public.weeks set phase='published',published_version_id=pub,published_days=array[w,w+1,w+2,w+3,w+4,w+5,w+6] where department_id=dept and week_start=w;
  perform set_config('app.in_publish','off',true);
  update public.profiles set does_not_drive = false where id in (m1, m2);

  dt := ((w+1)+time '08:00') at time zone 'Asia/Jerusalem';
  base := jsonb_build_object('department_id',dept,'week_start',w,'ride_type_id',typ,'adults',1);

  -- the flag only goes with a two-way הקפצה
  perform set_config('request.jwt.claims',jsonb_build_object('sub',m1,'role','authenticated')::text,true);
  begin
    perform public.submit_request(base||jsonb_build_object('destination_id',haifa,'trip_type','round_trip','depart_at',dt,'return_at',dt+interval '7 hours','keep_car_at_destination',true));
    raise exception 'keep-car accepted on a plain round trip';
  exception when raise_exception then if sqlerrm <> 'invalid_keep_car_at_destination' then raise; end if;
  end;

  -- m1 drives to Haifa at 08:00, back at 15:00, the car waits in Haifa
  res := public.submit_request(base||jsonb_build_object('destination_id',haifa,'trip_type','drop_off','depart_at',dt,'return_at',dt+interval '7 hours','keep_car_at_destination',true));
  assert res->>'status' = 'assigned', format('keep-car: placed, got %s', res);
  q := (res->>'request_id')::uuid;
  assert (select keep_car_at_destination and trip_type = 'drop_off' and trip_shape = 'round_trip' from public.requests where id = q), 'keep-car: stored as a two-way הקפצה with the flag';
  select r.car_id, r.starts_at, r.ends_at, r.destination_id, r.driver_id, rr.car_mode, rr.role into v_out
    from public.ride_requests rr join public.rides r on r.id = rr.ride_id where rr.request_id = q and rr.leg = 'out' and r.status <> 'cancelled';
  select r.car_id, r.starts_at, r.ends_at, r.origin_id, r.driver_id, rr.car_mode, rr.role into v_ret
    from public.ride_requests rr join public.rides r on r.id = rr.ride_id where rr.request_id = q and rr.leg = 'return' and r.status <> 'cancelled';
  assert v_out.car_id is not null and v_out.car_id = v_ret.car_id, format('keep-car: both legs on one car (%s / %s)', v_out.car_id, v_ret.car_id);
  assert v_out.destination_id = haifa and v_ret.origin_id = haifa, 'keep-car: the out leg ends and the return leg starts in Haifa';
  assert v_out.driver_id = m1 and v_ret.driver_id = m1 and v_out.car_mode = 'relay' and v_ret.car_mode = 'relay', 'keep-car: m1 drives both connected legs';
  assert v_out.ends_at < v_ret.starts_at - interval '4 hours', 'keep-car: the car is free in Haifa for hours between the legs';
  v_car := v_out.car_id;

  -- m2, in Haifa, goes Haifa → Binyamina → Haifa at 10:00-12:00: only the car waiting in Haifa can take it
  perform set_config('request.jwt.claims',jsonb_build_object('sub',m2,'role','authenticated')::text,true);
  res := public.submit_request(base||jsonb_build_object('origin_id',haifa,'destination_id',binyamina,'trip_type','round_trip',
    'depart_at',dt+interval '2 hours','return_at',dt+interval '4 hours'));
  assert res->>'status' = 'assigned' and (res->>'car_id')::uuid = v_car, format('the car waiting in Haifa takes a trip from Haifa, got %s', res);

  -- a member who does not drive cannot keep a car anywhere
  update public.profiles set does_not_drive = true where id = m2;
  begin
    perform public.submit_request(base||jsonb_build_object('destination_id',haifa,'trip_type','drop_off','depart_at',dt+interval '1 day','return_at',dt+interval '1 day 5 hours','keep_car_at_destination',true));
    raise exception 'keep-car accepted for a member who does not drive';
  exception when raise_exception then if sqlerrm <> 'invalid_keep_car_at_destination' then raise; end if;
  end;

  -- a repeating request carries the flag: the template keeps it and the next open week's suggestion shows it
  insert into public.weeks(department_id,week_start,phase,open_at,close_at,publish_at)
  values(dept,w+7,'open',now()-interval '1 day',now()+interval '5 days',now()+interval '6 days');
  perform set_config('request.jwt.claims',jsonb_build_object('sub',m1,'role','authenticated')::text,true);
  declare tpl uuid;
  begin
    tpl := public.save_request_template(q);
    assert (select keep_car_at_destination from public.request_templates where id = tpl), 'template: keeps the flag';
    assert (select keep_car_at_destination and trip_type = 'drop_off' from public.v_request_template_suggestions
            where template_id = tpl and week_start = w+7), 'template: the open week''s suggestion carries the flag';
  end;

  -- the Sadran switching it to a plain round trip clears the flag instead of failing on the constraint
  perform set_config('request.jwt.claims',jsonb_build_object('sub',sadran,'role','authenticated')::text,true);
  perform public.set_request_trip_type(q, 'round_trip', (select version from public.requests where id = q));
  assert (select trip_type = 'round_trip' and not keep_car_at_destination from public.requests where id = q),
    'trip-type change: a round trip no longer keeps the car at the destination';
  -- ... and back: the Sadran chooses "round trip, the car stays at the destination" again (both legs on one car)
  res := public.set_request_trip_type(q, 'drop_off', (select version from public.requests where id = q), true);
  assert (select trip_type = 'drop_off' and trip_shape = 'round_trip' and keep_car_at_destination from public.requests where id = q),
    format('trip-type change back to keep-car: flag on, got %s', res);
  assert (select count(distinct r.car_id) = 1 and count(*) = 2 from public.ride_requests rr join public.rides r on r.id = rr.ride_id
          where rr.request_id = q and r.status <> 'cancelled'), format('trip-type change back: both legs on one car, got %s', res);
  begin
    perform public.set_request_trip_type(q, 'one_way', (select version from public.requests where id = q), true);
    raise exception 'keep-car accepted on a one-way';
  exception when raise_exception then if sqlerrm <> 'invalid_keep_car_at_destination' then raise; end if;
  end;

  raise notice 'keep_car_at_destination.sql: all assertions passed';
end $$;

-- Owner 2026-10-11: plan B ("אם אין רכב, הקפצה…") together with "the car is available at the destination". Stored with the
-- kept-car request; the Sadran's plan-B proposal, once accepted, turns it into the plain plan-B הקפצה (flag off, kept in
-- original_main); undoing the plan B brings the kept-car trip back.
do $$
declare
  dept uuid := '00000000-0000-0000-0000-000000000001';
  manager uuid := '00000000-0000-0000-0000-000000000102';
  m1 uuid := '00000000-0000-0000-0000-000000000103';
  haifa uuid := '00000000-0000-0000-0000-000000000011';
  binyamina uuid := '00000000-0000-0000-0000-000000000012';
  typ uuid := '00000000-0000-0000-0000-000000000021';
  carA uuid;
  w date := public.current_week_start() + 1232;
  d timestamptz; res jsonb; q uuid; prop uuid; toks jsonb; a public.request_alternatives%rowtype; r public.requests%rowtype;
begin
  update public.profiles set does_not_drive = false where id = m1;
  update public.destinations set is_drop_point = true where id = binyamina;
  insert into public.weeks(department_id, week_start, phase, open_at, close_at, publish_at)
  values (dept, w, 'open', now() - interval '3 days', now() + interval '2 days', now() + interval '3 days');
  perform set_config('request.jwt.claims', jsonb_build_object('sub', m1, 'role', 'authenticated')::text, true);
  d := ((w + 1) + time '07:00') at time zone 'Asia/Jerusalem';
  res := public.submit_request(jsonb_build_object('department_id', dept, 'week_start', w, 'destination_id', haifa, 'ride_type_id', typ,
    'trip_type', 'drop_off', 'keep_car_at_destination', true, 'depart_at', d, 'return_at', d + interval '8 hours',
    'fallback', 'alternative', 'alternative', jsonb_build_object('drop_place_id', binyamina, 'arrive_by', d + interval '1 hour',
      'pickup', true, 'pickup_at', d + interval '9 hours')));
  q := (res ->> 'request_id')::uuid;
  select * into r from public.requests where id = q;
  assert r.keep_car_at_destination and r.fallback = 'alternative', 'plan B is stored with a kept-car request';
  assert exists (select 1 from public.request_alternatives where request_id = q and drop_place_id = binyamina), 'the plan B row exists';

  perform set_config('request.jwt.claims', jsonb_build_object('sub', manager, 'role', 'authenticated')::text, true);
  select * into a from public.request_alternatives where request_id = q;
  -- a car standing at home then (earlier blocks of this transaction may have left one in Haifa)
  select c.id into carA from public.cars c where c.department_id = dept and c.type = 'shared' and c.status = 'active'
    and public.car_location_at(c.id, a.arrive_by - interval '30 minutes') = '00000000-0000-0000-0000-000000000010' order by c.id limit 1;
  prop := public.create_proposal(q, null, 'alternative', jsonb_build_object('car_id', carA,
    'depart_at', a.arrive_by - interval '30 minutes', 'return_at', a.pickup_at + interval '15 minutes'), 'plan B');
  toks := public.send_proposal(prop);
  perform public.answer_proposal(toks -> 'party_tokens' ->> m1::text, true);
  select * into r from public.requests where id = q;
  select * into a from public.request_alternatives where request_id = q;
  assert r.served_by_alternative and r.destination_id = binyamina and not r.keep_car_at_destination,
    format('plan B applied: the plain הקפצה to Binyamina, flag off (served %s, dest %s, keep %s)', r.served_by_alternative, r.destination_id, r.keep_car_at_destination);
  assert (a.original_main ->> 'keep_car_at_destination')::boolean, 'the kept-car setting is remembered with the main trip';

  perform public._restore_original_main(q);
  select * into r from public.requests where id = q;
  assert r.keep_car_at_destination and r.destination_id = haifa and r.trip_type = 'drop_off' and not r.served_by_alternative,
    'undoing plan B brings the kept-car trip back';

  raise notice 'keep_car_at_destination.sql: plan B with a kept car passed';
end $$;
rollback;
