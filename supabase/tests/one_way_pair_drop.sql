-- R20H3 (owner 2026-11-14): a lone one-way pair placed together from the board ("לשבץ את שתיהן").
--   TEST 1  one_way_partner finds the opposite unplaced leg of the same day that departs later; none for a leg the
--           other way round, another day, or one that leaves before
--   TEST 2  place_one_way_pair puts both on the car: the out-leg leaves the car at X, the return leg starts there
--   TEST 3  refusals: a member may not call either; a pair that is not opposite legs
--   TEST 4  (owner 2026-11-15) a lone return leg on a car standing at home: refused without the Sadran's
--           "לשבץ בכל זאת?" (`allow_chain_break`), placed from Haifa with it
-- Transactional, rolled back at the end.
begin;

create temporary table owp(k text primary key, id uuid);

do $$
declare
  dept uuid := '00000000-0000-0000-0000-000000000001';
  sadran uuid := '00000000-0000-0000-0000-000000000102';
  m103 uuid := '00000000-0000-0000-0000-000000000103';
  m104 uuid := '00000000-0000-0000-0000-000000000104';
  home uuid := '00000000-0000-0000-0000-000000000010';
  haifa uuid := '00000000-0000-0000-0000-000000000011';
  typ uuid := '00000000-0000-0000-0000-000000000021';
  w date := public.current_week_start() + 441;
  base jsonb; qa uuid; qb uuid; qearly uuid; qother uuid;
begin
  insert into public.weeks(department_id, week_start, phase, open_at, close_at, publish_at) values
    (dept, w, 'open', now() - interval '1 day', now() + interval '1 day', now() + interval '2 days');
  base := jsonb_build_object('department_id', dept, 'week_start', w, 'ride_type_id', typ, 'trip_type', 'one_way', 'adults', 1);
  perform set_config('request.jwt.claims', jsonb_build_object('sub', m103, 'role', 'authenticated')::text, true);
  qa := (public.submit_request(base || jsonb_build_object('origin_id', home, 'destination_id', haifa,
    'depart_at', ((w + 2) + time '08:00') at time zone 'Asia/Jerusalem')) ->> 'request_id')::uuid;
  perform set_config('request.jwt.claims', jsonb_build_object('sub', m104, 'role', 'authenticated')::text, true);
  qearly := (public.submit_request(base || jsonb_build_object('origin_id', haifa, 'destination_id', home,
    'depart_at', ((w + 2) + time '07:00') at time zone 'Asia/Jerusalem')) ->> 'request_id')::uuid;
  qother := (public.submit_request(base || jsonb_build_object('origin_id', haifa, 'destination_id', home,
    'depart_at', ((w + 3) + time '14:00') at time zone 'Asia/Jerusalem')) ->> 'request_id')::uuid;
  qb := (public.submit_request(base || jsonb_build_object('origin_id', haifa, 'destination_id', home,
    'depart_at', ((w + 2) + time '14:00') at time zone 'Asia/Jerusalem')) ->> 'request_id')::uuid;
  insert into owp values ('qa', qa), ('qb', qb), ('qearly', qearly), ('qother', qother);
end $$;

-- TEST 1
do $$
declare
  sadran uuid := '00000000-0000-0000-0000-000000000102';
  car uuid := '00000000-0000-0000-0000-000000000040';
  res jsonb;
begin
  perform set_config('request.jwt.claims', jsonb_build_object('sub', sadran, 'role', 'authenticated')::text, true);
  res := public.one_way_partner((select id from owp where k = 'qa'), car);
  assert res ->> 'request_id' = (select id from owp where k = 'qb')::text,
    format('TEST 1 FAILED: the 14:00 return of the same day, not the 07:00 one or the next day''s, got %s', res);
  assert res ->> 'origin_name' is not null and res ->> 'destination_name' is not null and res ->> 'requester_name' is not null,
    format('TEST 1 FAILED: names for the question, got %s', res);
  assert not exists (select 1 from public.ride_requests where request_id in (select id from owp)),
    'TEST 1 FAILED: the probe placed nothing';
  assert public.one_way_partner((select id from owp where k = 'qb'), car) is null,
    'TEST 1 FAILED: a return leg is not offered an out-leg after it';
  raise notice 'TEST 1 passed: the opposite leg is found, the probe leaves nothing';
end $$;

-- TEST 2
do $$
declare
  car uuid := '00000000-0000-0000-0000-000000000040';
  home uuid := '00000000-0000-0000-0000-000000000010';
  haifa uuid := '00000000-0000-0000-0000-000000000011';
  res jsonb; r1 public.rides%rowtype; r2 public.rides%rowtype;
begin
  res := public.place_one_way_pair((select id from owp where k = 'qa'), (select id from owp where k = 'qb'), car);
  set constraints all immediate;
  set constraints all deferred;
  select * into r1 from public.rides where id = (res ->> 'out_ride_id')::uuid;
  select * into r2 from public.rides where id = (res ->> 'return_ride_id')::uuid;
  assert r1.car_id = car and r2.car_id = car and r1.status <> 'cancelled' and r2.status <> 'cancelled',
    format('TEST 2 FAILED: both on the car, got %s', res);
  assert r1.origin_id = home and r1.destination_id = haifa and r2.origin_id = haifa and r2.destination_id = home,
    'TEST 2 FAILED: home → Haifa, then Haifa → home';
  assert (select count(*) from public.requests where id in ((select id from owp where k = 'qa'), (select id from owp where k = 'qb')) and status = 'assigned') = 2,
    'TEST 2 FAILED: both requests are placed';
  raise notice 'TEST 2 passed: both legs on one car';
end $$;

-- TEST 3
do $$
declare
  car uuid := '00000000-0000-0000-0000-000000000040';
begin
  perform set_config('request.jwt.claims', jsonb_build_object('sub', '00000000-0000-0000-0000-000000000104', 'role', 'authenticated')::text, true);
  begin
    perform public.one_way_partner((select id from owp where k = 'qa'), car);
    raise exception 'TEST 3 FAILED: a member probed a pair';
  exception when raise_exception then if sqlerrm <> 'not_authorized' then raise; end if; end;
  begin
    perform public.place_one_way_pair((select id from owp where k = 'qearly'), (select id from owp where k = 'qother'), car);
    raise exception 'TEST 3 FAILED: a member placed a pair';
  exception when raise_exception then if sqlerrm <> 'not_authorized' then raise; end if; end;
  perform set_config('request.jwt.claims', jsonb_build_object('sub', '00000000-0000-0000-0000-000000000102', 'role', 'authenticated')::text, true);
  begin
    perform public.place_one_way_pair((select id from owp where k = 'qearly'), (select id from owp where k = 'qother'), car);
    raise exception 'TEST 3 FAILED: two legs the same way were placed as a pair';
  exception when raise_exception then if sqlerrm <> 'one_way_pair_invalid' then raise; end if; end;
  raise notice 'TEST 3 passed: refusals';
end $$;

-- TEST 4
create or replace function pg_temp.owp_shift(p_req uuid, p_requester uuid, p_payload jsonb) returns uuid
language plpgsql as $f$
declare prop uuid;
begin
  prop := public.create_proposal(p_req, null, 'shift', p_payload, 'x');
  perform public.send_proposal(prop, '{}');
  perform public.record_answer_on_behalf(prop, p_requester, true);
  if (select status from public.proposals where id = prop) = 'accepted' then perform public.apply_proposal(prop); end if;
  if (select status from public.proposals where id = prop) = 'withdrawn' then
    raise exception '%', coalesce((select n.data ->> 'reason' from public.notifications n
      where n.data ->> 'proposal_id' = prop::text and n.data ->> 'variant' = 'withdrawn_stale' order by n.created_at desc limit 1), 'shift_not_applied');
  end if;
  return (select applied_ride_id from public.proposals where id = prop);
end $f$;
do $$
declare
  car uuid := '00000000-0000-0000-0000-000000000041';
  m104 uuid := '00000000-0000-0000-0000-000000000104';
  home uuid := '00000000-0000-0000-0000-000000000010';
  haifa uuid := '00000000-0000-0000-0000-000000000011';
  q uuid := (select id from owp where k = 'qother'); rid uuid; r public.rides%rowtype;
begin
  assert public.car_location_at(car, (select depart_at from public.requests where id = q)) = home, 'setup: the car stands at home';
  begin
    perform pg_temp.owp_shift(q, m104, jsonb_build_object('car_id', car));
    raise exception 'TEST 4 FAILED: placed from Haifa with no waiver';
  exception when others then if sqlerrm not like '%car_not_at_leg_origin%' then raise; end if; end;
  rid := pg_temp.owp_shift(q, m104, jsonb_build_object('car_id', car, 'allow_chain_break', true));
  set constraints all immediate;
  set constraints all deferred;
  select * into r from public.rides where id = rid;
  assert r.car_id = car and r.origin_id = haifa and r.destination_id = home and r.status <> 'cancelled',
    format('TEST 4 FAILED: the leg is placed Haifa → home on the car, got %s', to_jsonb(r));
  raise notice 'TEST 4 passed: the Sadran''s "לשבץ בכל זאת?" places a leg where the car is not';
end $$;

rollback;
