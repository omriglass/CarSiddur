-- REQ §13.108 (f) / docs/TODO.md U3 — "be back on time": v_ride_car_neighbours gives, for every visible
-- ride, the counted ride right before / after it on the same car, the gap and whether it is tight
-- (threshold = greatest(the THIS ride's week turnaround incl. the per-week override, 30) minutes).
-- Transactional; rolled back at the end. Seeded נבו department …0001, Sadran …0102, members …0103 / …0104,
-- admin …0101, home …0010, חיפה …0011, ride type …0021, shared cars …0040 / …0041 / …0042.
-- Starts/ends sit on the quarter-hour grid, so the gaps below are multiples of 15 minutes.
begin;

create function pg_temp.mk_week(p_dept uuid, p_week date, p_days date[]) returns void language plpgsql as $$
declare pub uuid; sadran uuid := '00000000-0000-0000-0000-000000000102';
begin
  insert into public.weeks(department_id, week_start, phase, open_at, close_at, publish_at)
    values (p_dept, p_week, 'solving', now() - interval '3 days', now() - interval '2 days', now() - interval '1 day');
  insert into public.siddur_versions(department_id, week_start, snapshot, published_by) values (p_dept, p_week, '{}', sadran) returning id into pub;
  perform set_config('app.in_publish', 'on', true);
  update public.weeks set phase = 'published', published_version_id = pub, published_at = now(), published_days = p_days
    where department_id = p_dept and week_start = p_week;
  perform set_config('app.in_publish', 'off', true);
end $$;

-- kind: ride (serves a request of p_driver) | relay_out | relay_ret | reservation | car_move
create function pg_temp.mk(p_week date, p_car uuid, p_day date, p_start time, p_end time, p_driver uuid,
  p_kind text default 'ride', p_status public.ride_status default 'confirmed', p_series uuid default null,
  p_end_day date default null) returns uuid language plpgsql as $$
declare
  dept uuid := '00000000-0000-0000-0000-000000000001';
  home uuid := '00000000-0000-0000-0000-000000000010';
  haifa uuid := '00000000-0000-0000-0000-000000000011';
  typ uuid := '00000000-0000-0000-0000-000000000021';
  sadran uuid := '00000000-0000-0000-0000-000000000102';
  s timestamptz := (p_day + p_start) at time zone 'Asia/Jerusalem';
  e timestamptz := (coalesce(p_end_day, p_day) + p_end) at time zone 'Asia/Jerusalem';
  o uuid := home; d uuid := home;
  q uuid; r uuid;
begin
  if p_kind = 'relay_out' then d := haifa; end if;
  if p_kind = 'relay_ret' then o := haifa; end if;
  if p_kind in ('ride', 'relay_out', 'relay_ret') then
    insert into public.requests(department_id, week_start, requester_id, filed_by, destination_id, ride_type_id,
      trip_shape, depart_at, return_at, adults, submitted_at, status)
    values (dept, p_week, p_driver, p_driver, haifa, typ, 'round_trip', s, e, 1, now(), 'assigned') returning id into q;
  end if;
  insert into public.rides(department_id, week_start, car_id, starts_at, ends_at, origin_id, destination_id,
    driver_id, status, created_by, series_id, auto_relocation, is_pinned, pin_reason, notes,
    cancelled_at, cancelled_by, cancel_reason)
  values (dept, p_week, p_car, s, e, o, d, p_driver, p_status, sadran, p_series,
    p_kind = 'car_move', p_kind in ('reservation', 'car_move'),
    case p_kind when 'car_move' then 'CAR_MOVE' when 'reservation' then 'RESERVATION' end,
    case when p_kind in ('reservation', 'car_move') then 'test' end,
    case when p_status = 'cancelled' then now() end, case when p_status = 'cancelled' then sadran end,
    case when p_status = 'cancelled' then 'test' end)
  returning id into r;
  if q is not null then
    insert into public.ride_requests(ride_id, request_id, role, leg, car_mode)
    values (r, q, 'driver', (case p_kind when 'relay_out' then 'out' when 'relay_ret' then 'return' else 'both' end)::public.ride_leg,
      (case when p_kind in ('relay_out', 'relay_ret') then 'relay' else 'keep' end)::public.leg_car_mode);
  end if;
  return r;
end $$;

do $$
declare
  dept uuid := '00000000-0000-0000-0000-000000000001';
  sadran uuid := '00000000-0000-0000-0000-000000000102';
  m1 uuid := '00000000-0000-0000-0000-000000000103';
  m2 uuid := '00000000-0000-0000-0000-000000000104';
  car_a uuid := '00000000-0000-0000-0000-000000000040';
  car_b uuid := '00000000-0000-0000-0000-000000000041';
  car_c uuid := '00000000-0000-0000-0000-000000000042';
  w date := public.current_week_start() + 1050;
  w2 date := w + 7;
  w3 date := w + 14;
  n1 text; n2 text; nsad text;
  a uuid; b uuid; c uuid; v record; ser uuid := gen_random_uuid();
  a_t uuid; b_t uuid; unpub uuid;
begin
  select full_name into n1 from public.profiles where id = m1;
  select full_name into n2 from public.profiles where id = m2;
  select full_name into nsad from public.profiles where id = sadran;
  update public.department_settings set turnaround_minutes = 15 where department_id = dept;

  -- week w: published except w+5; week w2: published, 60-minute turnaround override; week w3 not published.
  perform pg_temp.mk_week(dept, w, array[w, w+1, w+2, w+3, w+4, w+6]);
  perform pg_temp.mk_week(dept, w2, array[w2, w2+1, w2+2, w2+3, w2+4, w2+5, w2+6]);
  update public.weeks set settings_overrides = jsonb_build_object('turnaround_minutes', 60) where department_id = dept and week_start = w2;
  insert into public.weeks(department_id, week_start, phase, open_at, close_at, publish_at)
    values (dept, w3, 'solving', now() - interval '3 days', now() - interval '2 days', now() - interval '1 day');

  -- (a) another member's ride 30 minutes after mine: tight; mirror on the next ride
  a := pg_temp.mk(w, car_a, w, '08:00', '10:00', m1);
  b := pg_temp.mk(w, car_a, w, '10:30', '12:00', m2);   -- gap 30 = threshold (dept turnaround 15 still uses 30)
  set constraints all immediate; set constraints all deferred;
  select * into v from public.v_ride_car_neighbours where ride_id = a;
  assert v.threshold_minutes = 30, format('(a) dept turnaround 15 must still give threshold 30, got %s', v.threshold_minutes);
  assert v.next_ride_id = b and v.next_tight and v.next_gap_minutes = 30 and v.next_kind = 'ride', format('(a) %s', v);
  assert v.next_name = n2 and v.next_people = array[m2], format('(a) next name/people %s', v);
  assert v.next_starts_at = (w + time '10:30') at time zone 'Asia/Jerusalem', '(a) next_starts_at';
  assert not v.prev_tight, '(a) no tight ride before the first ride of the day on this car';
  select * into v from public.v_ride_car_neighbours where ride_id = b;
  assert v.prev_ride_id = a and v.prev_tight and v.prev_gap_minutes = 30 and v.prev_name = n1 and v.prev_people = array[m1],
    format('(a) mirror fields %s', v);
  assert v.prev_ends_at = (w + time '10:00') at time zone 'Asia/Jerusalem', '(a) prev_ends_at';

  -- (a2) a gap shorter than 30 (department turnaround 15) is tight too
  a := pg_temp.mk(w, car_a, w + 6, '12:00', '13:00', m1);
  b := pg_temp.mk(w, car_a, w + 6, '13:15', '14:00', m2);
  select * into v from public.v_ride_car_neighbours where ride_id = a;
  assert v.next_ride_id = b and v.next_tight and v.next_gap_minutes = 15, format('(a2) %s', v);

  -- (b) gap above the threshold: not tight (but the neighbour is still reported)
  a := pg_temp.mk(w, car_a, w + 1, '08:00', '10:00', m1);
  b := pg_temp.mk(w, car_a, w + 1, '10:45', '12:00', m2);   -- gap 45 > 30
  select * into v from public.v_ride_car_neighbours where ride_id = a;
  assert v.next_ride_id = b and v.next_gap_minutes = 45 and not v.next_tight, format('(b) %s', v);

  -- (c) the week override (60) is read from THIS ride's week: gap 60 (the week turnaround itself) tight in w2, gap 75 not
  a := pg_temp.mk(w2, car_a, w2 + 1, '08:00', '10:00', m1);
  b := pg_temp.mk(w2, car_a, w2 + 1, '11:00', '12:30', m2);
  select * into v from public.v_ride_car_neighbours where ride_id = a;
  assert v.threshold_minutes = 60 and v.next_tight and v.next_gap_minutes = 60, format('(c) override 60, gap 60 must be tight: %s', v);
  a := pg_temp.mk(w2, car_a, w2 + 2, '08:00', '10:00', m1);
  b := pg_temp.mk(w2, car_a, w2 + 2, '11:15', '12:30', m2);
  select * into v from public.v_ride_car_neighbours where ride_id = a;
  assert v.next_gap_minutes = 75 and not v.next_tight, format('(c) gap 75 above override 60: %s', v);

  -- (d) the same multi-day series never counts as the next ride
  a := pg_temp.mk(w, car_a, w + 2, '08:00', '10:00', m1, 'ride', 'confirmed', ser);
  b := pg_temp.mk(w, car_a, w + 2, '10:30', '12:00', m1, 'ride', 'confirmed', ser);
  select * into v from public.v_ride_car_neighbours where ride_id = a;
  assert v.next_ride_id is distinct from b and not v.next_tight, format('(d) same series must not be the next ride: %s', v);

  -- (e) a cancelled ride never counts
  a := pg_temp.mk(w, car_a, w + 3, '08:00', '10:00', m1);
  b := pg_temp.mk(w, car_a, w + 3, '10:15', '12:00', m2, 'ride', 'cancelled');
  select * into v from public.v_ride_car_neighbours where ride_id = a;
  assert v.next_ride_id is distinct from b and not v.next_tight, format('(e) cancelled ride counted: %s', v);

  -- (f) the next ride on an unpublished day does not count — for the member and for the Sadran alike
  a := pg_temp.mk(w, car_b, w + 4, '22:00', '23:45', m1);
  unpub := pg_temp.mk(w, car_b, w + 5, '00:00', '02:00', m2);
  set constraints all immediate; set constraints all deferred;
  select * into v from public.v_ride_car_neighbours where ride_id = a;
  assert v.next_ride_id is distinct from unpub and not v.next_tight, format('(f) owner view: unpublished day counted: %s', v);

  -- (g) one-way relay partner: the other half of the pair is the next ride
  a := pg_temp.mk(w, car_b, w + 6, '08:00', '10:00', m1, 'relay_out');
  b := pg_temp.mk(w, car_b, w + 6, '10:30', '12:00', m2, 'relay_ret');
  set constraints all immediate; set constraints all deferred;
  select * into v from public.v_ride_car_neighbours where ride_id = a;
  assert v.next_ride_id = b and v.next_tight and v.next_kind = 'ride' and v.next_name = n2, format('(g) relay partner: %s', v);

  -- (h) reservation (no served request): kind reservation; name null until someone is named on it
  a := pg_temp.mk(w, car_b, w, '08:00', '10:00', m1);
  b := pg_temp.mk(w, car_b, w, '10:15', '12:00', null, 'reservation');
  set constraints all immediate; set constraints all deferred;
  select * into v from public.v_ride_car_neighbours where ride_id = a;
  assert v.next_ride_id = b and v.next_tight and v.next_kind = 'reservation' and v.next_name is null and v.next_people = '{}',
    format('(h) reservation: %s', v);
  insert into public.ride_passengers(ride_id, department_id, week_start, person_id, display_name, seat_kind, added_by)
    values (b, dept, w, m2, 'x', 'adult', sadran);
  select * into v from public.v_ride_car_neighbours where ride_id = a;
  assert v.next_name = 'x' and v.next_people = array[m2], format('(h) reservation passenger name/people: %s', v);

  -- (i) car move (auto_relocation + CAR_MOVE)
  a := pg_temp.mk(w, car_b, w + 1, '08:00', '10:00', m1);
  b := pg_temp.mk(w, car_b, w + 1, '10:30', '11:00', sadran, 'car_move');
  set constraints all immediate; set constraints all deferred;
  select * into v from public.v_ride_car_neighbours where ride_id = a;
  assert v.next_ride_id = b and v.next_tight and v.next_kind = 'car_move' and v.next_name = nsad, format('(i) car move: %s', v);

  -- (j) cross-week: Saturday 23:45 (week w, threshold 30) -> Sunday 00:45 (week w2, override 60), gap 60
  a := pg_temp.mk(w, car_c, w + 6, '22:00', '23:45', m1);
  b := pg_temp.mk(w2, car_c, w2, '00:45', '02:00', m2);
  set constraints all immediate; set constraints all deferred;
  select * into v from public.v_ride_car_neighbours where ride_id = a;
  assert v.next_ride_id = b and v.next_gap_minutes = 60 and not v.next_tight, format('(j) Saturday ride: %s', v);
  select * into v from public.v_ride_car_neighbours where ride_id = b;
  assert v.prev_ride_id = a and v.prev_gap_minutes = 60 and v.prev_tight and v.threshold_minutes = 60,
    format('(j) Sunday ride mirrors with its own week threshold: %s', v);

  -- (k) visibility: a member never gets a row for a ride RLS hides; no counted neighbour on an unpublished day
  a_t := pg_temp.mk(w, car_c, w + 3, '08:00', '10:00', m1);
  b_t := pg_temp.mk(w, car_c, w + 3, '10:15', '12:00', m2);
  set constraints all immediate; set constraints all deferred;

  perform set_config('request.jwt.claims', jsonb_build_object('sub', m1, 'role', 'authenticated')::text, true);
  set local role authenticated;
  select * into v from public.v_ride_car_neighbours where ride_id = a_t;
  assert v.next_ride_id = b_t and v.next_tight and v.next_name = n2,
    format('(k) a member reads the neighbours of a published ride: %s', v);
  assert (select count(*) from public.v_ride_car_neighbours where ride_id = unpub) = 0,
    '(k) a ride on an unpublished day is invisible to a member';
  select * into v from public.v_ride_car_neighbours where ride_id = (select id from public.rides where car_id = car_b and starts_at = (w + 4 + time '22:00') at time zone 'Asia/Jerusalem');
  assert not v.next_tight and v.next_ride_id is distinct from unpub, '(k) member: unpublished next day never counts';
  reset role;

  perform set_config('request.jwt.claims', jsonb_build_object('sub', sadran, 'role', 'authenticated')::text, true);
  set local role authenticated;
  select * into v from public.v_ride_car_neighbours where ride_id = (select id from public.rides where car_id = car_b and starts_at = (w + 4 + time '22:00') at time zone 'Asia/Jerusalem');
  assert not v.next_tight and v.next_ride_id is distinct from unpub, '(k) the Sadran gets the same rule: an unpublished day never counts';
  reset role;

  -- anon has no access to the view at all.
  begin
    set local role anon;
    perform 1 from public.v_ride_car_neighbours limit 1;
    reset role;
    raise exception '(k) anon must not read v_ride_car_neighbours';
  exception when insufficient_privilege then
    reset role;
  end;

  raise notice 'car_handover_notes: all assertions passed';
end $$;

rollback;
