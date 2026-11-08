-- REQ §5.2 (owner 2026-10-05): an `external` request is treated like `denied` for freed-slot offers
-- unless freed_slot_opt_out. Transactional.
begin;
do $$
declare
  dept uuid := '00000000-0000-0000-0000-000000000001';
  member uuid := '00000000-0000-0000-0000-000000000103';
  dest uuid := '00000000-0000-0000-0000-000000000011';
  home uuid := '00000000-0000-0000-0000-000000000010';  -- default request origin; the freed car sits at home
  ride_type uuid := '00000000-0000-0000-0000-000000000021';
  car uuid := '00000000-0000-0000-0000-000000000040';
  w date := public.current_week_start() + 336;
  r_ext uuid; r_opt uuid; cancelled uuid; offer uuid;
begin
  insert into public.weeks(department_id, week_start, phase, open_at, close_at, publish_at)
    values (dept, w, 'open', now() - interval '1 day', now() + interval '1 day', now() + interval '2 days');
  insert into public.rides(department_id, week_start, car_id, driver_id, destination_id, origin_id, created_by, cancelled_at, cancelled_by, cancel_reason, starts_at, ends_at, status)
    values (dept, w, car, member, home, home, member, now(), member, 'test',
      ((w + 2) + time '08:00') at time zone 'Asia/Jerusalem', ((w + 2) + time '18:00') at time zone 'Asia/Jerusalem', 'cancelled')
    returning id into cancelled;
  insert into public.requests(department_id, week_start, requester_id, filed_by, destination_id, ride_type_id,
      depart_at, return_at, trip_shape, status, freed_slot_opt_out)
    values (dept, w, member, member, dest, ride_type, ((w + 2) + time '10:00') at time zone 'Asia/Jerusalem',
      ((w + 2) + time '14:00') at time zone 'Asia/Jerusalem', 'round_trip', 'external', false) returning id into r_ext;
  insert into public.requests(department_id, week_start, requester_id, filed_by, destination_id, ride_type_id,
      depart_at, return_at, trip_shape, status, freed_slot_opt_out)
    values (dept, w, member, member, dest, ride_type, ((w + 2) + time '10:00') at time zone 'Asia/Jerusalem',
      ((w + 2) + time '14:00') at time zone 'Asia/Jerusalem', 'round_trip', 'external', true) returning id into r_opt;
  insert into public.freed_slot_offers(department_id, week_start, car_id, cancelled_ride_id, starts_at, ends_at, expires_at)
    values (dept, w, car, cancelled, ((w + 2) + time '08:00') at time zone 'Asia/Jerusalem',
      ((w + 2) + time '18:00') at time zone 'Asia/Jerusalem', now() + interval '1 day') returning id into offer;
  assert exists (select 1 from public.freed_slot_candidates(offer) c where c.request_id = r_ext),
    'an external request was not offered the freed slot';
  assert not exists (select 1 from public.freed_slot_candidates(offer) c where c.request_id = r_opt),
    'an opted-out external request was offered the freed slot';
end $$;
-- REQ §13.193 (owner 2026-11-08): a waiting-list הקפצה with one leg is offered the freed car as its chauffeur ride
-- at its own time, and the offer places it on that car.
do $$
declare
  dept uuid := '00000000-0000-0000-0000-000000000001';
  member uuid := '00000000-0000-0000-0000-000000000103';
  dest uuid := '00000000-0000-0000-0000-000000000011';
  home uuid := '00000000-0000-0000-0000-000000000010';
  ride_type uuid := '00000000-0000-0000-0000-000000000021';
  car uuid := '00000000-0000-0000-0000-000000000040';
  w date := public.current_week_start() + 343;
  r_drop uuid; r_late uuid; cancelled uuid; offer uuid; v_ride uuid;
begin
  insert into public.weeks(department_id, week_start, phase, open_at, close_at, publish_at)
    values (dept, w, 'open', now() - interval '1 day', now() + interval '1 day', now() + interval '2 days');
  insert into public.rides(department_id, week_start, car_id, driver_id, destination_id, origin_id, created_by, cancelled_at, cancelled_by, cancel_reason, starts_at, ends_at, status)
    values (dept, w, car, member, home, home, member, now(), member, 'test',
      ((w + 2) + time '08:00') at time zone 'Asia/Jerusalem', ((w + 2) + time '18:00') at time zone 'Asia/Jerusalem', 'cancelled')
    returning id into cancelled;
  insert into public.requests(department_id, week_start, requester_id, filed_by, destination_id, origin_id, ride_type_id,
      depart_at, return_at, trip_shape, trip_type, one_way_car_mode, status)
    values (dept, w, member, member, dest, home, ride_type, ((w + 2) + time '10:00') at time zone 'Asia/Jerusalem',
      null, 'one_way_to', 'drop_off', 'passenger', 'waitlisted') returning id into r_drop;
  -- its chauffeur ride would run past the end of the freed gap
  insert into public.requests(department_id, week_start, requester_id, filed_by, destination_id, origin_id, ride_type_id,
      depart_at, return_at, trip_shape, trip_type, one_way_car_mode, status)
    values (dept, w, member, member, dest, home, ride_type, ((w + 2) + time '17:45') at time zone 'Asia/Jerusalem',
      null, 'one_way_to', 'drop_off', 'passenger', 'waitlisted') returning id into r_late;
  insert into public.freed_slot_offers(department_id, week_start, car_id, cancelled_ride_id, starts_at, ends_at, expires_at)
    values (dept, w, car, cancelled, ((w + 2) + time '08:00') at time zone 'Asia/Jerusalem',
      ((w + 2) + time '18:00') at time zone 'Asia/Jerusalem', now() + interval '1 day') returning id into offer;
  assert exists (select 1 from public.freed_slot_candidates(offer) c where c.request_id = r_drop),
    'a one-leg הקפצה on the waiting list was not offered the freed car';
  assert not exists (select 1 from public.freed_slot_candidates(offer) c where c.request_id = r_late),
    'a one-leg הקפצה whose chauffeur ride does not fit the gap was offered the freed car';
  assert public.freed_candidate_placeable(offer, r_drop),
    'the probe (no actor) refused the one-leg הקפצה — every הקפצה failed it on a null created_by';
  v_ride := public.place_freed_slot_request(offer, r_drop, null, 'FREED_SLOT');
  assert exists (select 1 from public.rides r join public.ride_requests rr on rr.ride_id = r.id
                 where rr.request_id = r_drop and r.car_id = car and r.status <> 'cancelled'
                   and r.starts_at = ((w + 2) + time '10:00') at time zone 'Asia/Jerusalem'),
    'the freed car did not take the one-leg הקפצה at its own time';
end $$;
rollback;
