-- REQ §13.168 QA scenario: a freed car that a plan B, two waiting-list requests and a combination compete for.
-- Disposable / QA stacks only (never the owner's stack, never production). Run as the database owner:
--
--   docker exec -i <db container> psql -U postgres -v ON_ERROR_STOP=1 \
--     -v dept=<department id> -v day=<YYYY-MM-DD> -v car=<shared car id, free all that day> \
--     -v plan_b_car=<another shared car, free all that day> -v cancel=yes|no < scripts/qa/freed-car-scenario.sql
--
-- On `day`, four members of the department with no request that day get:
--   A  07:00–20:00 on `car` (the ride that will be cancelled)
--   W1 10:00–12:00 and W2 19:00–22:00 on the waiting list
--   P  07:00–17:00, served by its plan B (a הקפצה to the department's first other place) on `plan_b_car` — the plan-B
--      chauffeur ride still needs a driver, as often happens
-- With cancel=yes the Sadran cancels A's ride through cancel_ride(): the car is offered, and — with the
-- on-ride-cancelled edge function wired (app_settings.on_ride_cancelled_url + app_secrets.cron_secret) — the
-- offer waits for the Sadran with the ranked options (W1+W2 recommended, P+W2, W1, P, W2). With cancel=no the
-- tester cancels it in the app (the ride sheet, as A or as the Sadran).
select set_config('scn.dept', :'dept', false), set_config('scn.day', :'day', false), set_config('scn.car', :'car', false),
       set_config('scn.plan_b_car', :'plan_b_car', false), set_config('scn.cancel', :'cancel', false);

do $$
declare
  dept uuid := current_setting('scn.dept')::uuid;
  day date := current_setting('scn.day')::date;
  car uuid := current_setting('scn.car')::uuid;
  plan_b_car uuid := current_setting('scn.plan_b_car')::uuid;
  w date; home uuid; typ uuid; dest uuid; drop_place uuid; sadran uuid; d0 timestamptz;
  ma uuid; mw1 uuid; mw2 uuid; mp uuid; qa uuid; qw1 uuid; qw2 uuid; qp uuid; ride uuid; off uuid;
begin
  w := day - extract(dow from day)::int;
  d0 := (day + time '00:00') at time zone 'Asia/Jerusalem';
  select home_destination_id into home from public.departments where id = dept;
  select id into typ from public.ride_types where department_id = dept order by id limit 1;
  select id into dest from public.destinations where department_id = dept and id <> home order by name desc limit 1;
  select id into drop_place from public.destinations where department_id = dept and id <> home and id <> dest order by name limit 1;
  select s into sadran from public.sadranim_of(dept, w) s limit 1;
  if sadran is null then raise exception 'no Sadran for the week %', w; end if;
  select ids[1], ids[2], ids[3], ids[4] into ma, mw1, mw2, mp
  from (select array_agg(p.id order by p.full_name) as ids from (
    select p.id, p.full_name from public.profiles p join public.department_members m on m.profile_id = p.id
    where m.department_id = dept and m.removed_at is null and m.role = 'member' and p.id <> sadran
      and not p.does_not_drive                    -- a round trip on a shared car needs its requester to drive
      and not exists (select 1 from public.requests q where q.requester_id = p.id and q.week_start = w
                      and (coalesce(q.depart_at, q.return_at) at time zone 'Asia/Jerusalem')::date = day)
    order by p.full_name limit 4) p) x;
  if mp is null then raise exception 'fewer than four members free on %', day; end if;

  perform set_config('request.jwt.claims', jsonb_build_object('sub', sadran, 'role', 'authenticated')::text, true);
  perform set_config('app.system_status_transition', 'on', true);
  insert into public.requests (department_id, week_start, requester_id, filed_by, destination_id, ride_type_id, origin_id,
    trip_shape, trip_type, depart_at, return_at, status, submitted_at)
  values (dept, w, ma, ma, dest, typ, home, 'round_trip', 'round_trip', d0 + interval '7 hours', d0 + interval '20 hours', 'submitted', now())
  returning id into qa;
  insert into public.requests (department_id, week_start, requester_id, filed_by, destination_id, ride_type_id, origin_id,
    trip_shape, trip_type, depart_at, return_at, status, status_reason, submitted_at)
  values (dept, w, mw1, mw1, dest, typ, home, 'round_trip', 'round_trip', d0 + interval '10 hours', d0 + interval '12 hours', 'waitlisted', 'WAITLISTED_NO_CAR', now())
  returning id into qw1;
  insert into public.requests (department_id, week_start, requester_id, filed_by, destination_id, ride_type_id, origin_id,
    trip_shape, trip_type, depart_at, return_at, status, status_reason, submitted_at)
  values (dept, w, mw2, mw2, dest, typ, home, 'round_trip', 'round_trip', d0 + interval '19 hours', d0 + interval '22 hours', 'waitlisted', 'WAITLISTED_NO_CAR', now())
  returning id into qw2;
  insert into public.requests (department_id, week_start, requester_id, filed_by, destination_id, ride_type_id, origin_id,
    trip_shape, trip_type, depart_at, return_at, status, submitted_at, fallback)
  values (dept, w, mp, mp, dest, typ, home, 'round_trip', 'round_trip', d0 + interval '7 hours', d0 + interval '17 hours', 'submitted', now(), 'alternative')
  returning id into qp;
  insert into public.request_alternatives (request_id, department_id, week_start, drop_place_id, arrive_by, pickup, pickup_at)
  values (qp, dept, w, drop_place, d0 + interval '8 hours', true, d0 + interval '17 hours');
  perform set_config('app.system_status_transition', 'off', true);

  ride := public.place_request_on_car(qa, car, true, sadran, null, null, null, 'MANUAL');
  perform public._convert_to_alternative(qp, d0 + interval '7 hours 15 minutes', d0 + interval '17 hours 30 minutes');
  perform public.place_request_on_car(qp, plan_b_car, true, sadran, null, null, null, 'MANUAL');
  if not (select served_by_alternative from public.requests where id = qp) then
    raise exception 'P is not on its plan B';
  end if;
  raise notice 'scenario %: A=% (ride %), W1=%, W2=%, P=% (plan B)', day,
    (select full_name from public.profiles where id = ma), ride, (select full_name from public.profiles where id = mw1),
    (select full_name from public.profiles where id = mw2), (select full_name from public.profiles where id = mp);
  if current_setting('scn.cancel') = 'yes' then
    perform public.cancel_ride(ride, 'QA freed-car scenario', (select version from public.rides where id = ride));
    select id into off from public.freed_slot_offers where cancelled_ride_id = ride;
    raise notice 'cancelled; offer % (status %)', off, (select status from public.freed_slot_offers where id = off);
  end if;
end $$;
