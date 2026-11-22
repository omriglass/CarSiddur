-- SH2 (showcase 2026-11-22): a merge proposal that chains the same person's two trips into one ride reads "הצעה: לחבר את
-- שתי הנסיעות שלך לנסיעה אחת" with the chained route in order and the new hours (variant `merge_chain_self`, push/inbox/
-- WhatsApp), not "join <your own name>'s ride". An ordinary merge into someone else's ride keeps `merge_passenger`.
-- Transactional. Seeded נבו department; cars …0040 / …0042; home …0010, חיפה …0011, school …0012.
begin;

do $$
declare
  dept uuid := '00000000-0000-0000-0000-000000000001';
  manager uuid := '00000000-0000-0000-0000-000000000102';
  m1 uuid := '00000000-0000-0000-0000-000000000103';
  m2 uuid := '00000000-0000-0000-0000-000000000104';
  home uuid := '00000000-0000-0000-0000-000000000010';
  haifa uuid := '00000000-0000-0000-0000-000000000011';
  school uuid := '00000000-0000-0000-0000-000000000012';
  typ uuid := '00000000-0000-0000-0000-000000000021';
  car1 uuid := '00000000-0000-0000-0000-000000000040';
  car2 uuid := '00000000-0000-0000-0000-000000000042';
  w date := public.current_week_start() + 1491;
  d0 timestamptz; qA uuid; qB uuid; qC uuid; rA uuid; rB uuid; p uuid; v jsonb; v_text text;
begin
  insert into public.weeks(department_id, week_start, phase, open_at, close_at, publish_at)
    values (dept, w, 'solving', now() - interval '3 days', now() - interval '2 days', now() - interval '1 day');
  perform set_config('request.jwt.claims', jsonb_build_object('sub', manager, 'role', 'authenticated')::text, true);
  d0 := ((w + 1) + time '07:45') at time zone 'Asia/Jerusalem';

  -- A: m1 drops the kids at school 07:45-08:15 (car1); B: m1 to חיפה 08:30-14:00 (car2)
  insert into public.requests(department_id, week_start, requester_id, filed_by, origin_id, destination_id, ride_type_id, depart_at, return_at,
                              trip_type, trip_shape, status, adults)
    values (dept, w, m1, m1, home, school, typ, d0, d0 + interval '30 minutes', 'round_trip', 'round_trip', 'assigned', 1) returning id into qA;
  insert into public.rides(department_id, week_start, car_id, starts_at, ends_at, origin_id, destination_id, driver_id, status, created_by)
    values (dept, w, car1, d0, d0 + interval '30 minutes', home, home, m1, 'draft', manager) returning id into rA;
  insert into public.ride_requests(ride_id, request_id, role, leg, car_mode) values (rA, qA, 'driver', 'both', 'keep');
  insert into public.requests(department_id, week_start, requester_id, filed_by, origin_id, destination_id, ride_type_id, depart_at, return_at,
                              trip_type, trip_shape, status, adults)
    values (dept, w, m1, m1, home, haifa, typ, d0 + interval '45 minutes', d0 + interval '375 minutes', 'round_trip', 'round_trip', 'submitted', 1)
    returning id into qB;
  insert into public.rides(department_id, week_start, car_id, starts_at, ends_at, origin_id, destination_id, driver_id, status, created_by)
    values (dept, w, car2, d0 + interval '45 minutes', d0 + interval '375 minutes', home, home, m1, 'draft', manager) returning id into rB;
  insert into public.ride_requests(ride_id, request_id, role, leg, car_mode) values (rB, qB, 'driver', 'both', 'keep');

  -- 1) B proposed onto A's ride: the chain wording, the route in order, the new hours
  p := public.create_proposal(qB, rA, 'merge', jsonb_build_object('legs', jsonb_build_array(jsonb_build_object('ride_id', rA, 'leg', 'both'))), '', array[m1]);
  v := public.proposal_reader_vars(p, m1);
  assert v ->> 'variant' = 'merge_chain_self', format('TEST 1 FAILED: variant %s', v ->> 'variant');
  assert v -> 'vars' ->> 'chainRoute' = (select string_agg(d.name, ' ← ' order by x.o) from unnest(array[home, school, haifa, home]) with ordinality x(id, o)
                                          join public.destinations d on d.id = x.id),
    format('TEST 1 FAILED: route %s', v -> 'vars' ->> 'chainRoute');
  assert v -> 'vars' ->> 'chainWindow' = to_char(d0 at time zone 'Asia/Jerusalem', 'HH24:MI') || '–'
                                         || to_char((d0 + interval '375 minutes') at time zone 'Asia/Jerusalem', 'HH24:MI'),
    format('TEST 1 FAILED: hours %s', v -> 'vars' ->> 'chainWindow');
  select t.body into v_text from public.proposal_party_texts(p) t where t.profile_id = m1;
  assert v_text like '%לחבר את שתי הנסיעות שלך%' and v_text not like '%להצטרף%', format('TEST 1 FAILED: WhatsApp %s', v_text);

  -- 2) someone else's trip onto m1's ride: still "join m1's ride"
  insert into public.requests(department_id, week_start, requester_id, filed_by, origin_id, destination_id, ride_type_id, depart_at, return_at,
                              trip_type, trip_shape, status, adults)
    values (dept, w, m2, m2, home, haifa, typ, d0 + interval '45 minutes', d0 + interval '375 minutes', 'round_trip', 'round_trip', 'submitted', 1)
    returning id into qC;
  p := public.create_proposal(qC, rB, 'merge', jsonb_build_object('legs', jsonb_build_array(jsonb_build_object('ride_id', rB, 'leg', 'both'))), '', array[m2]);
  assert public.proposal_reader_vars(p, m2) ->> 'variant' = 'merge_passenger',
    format('TEST 2 FAILED: variant %s', public.proposal_reader_vars(p, m2) ->> 'variant');

  raise notice 'chain_self_proposal.sql: all tests passed';
end $$;

rollback;
