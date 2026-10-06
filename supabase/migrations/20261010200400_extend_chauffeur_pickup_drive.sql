-- REQ §13.104 / §13.93 (QA run 4 R4B7): a chauffeur ride from a car parked AWAY from the pickup includes the empty drive from where
-- the car is to the pickup (its window starts earlier) and the drive back to where the car stays. Heals rides written by paths that
-- sized the window from the pickup minute alone (board drop, free edit): for an `out` chauffeur leg whose ride place differs from the
-- request's origin, the ride starts at floor15(depart - drive(place -> origin) - chauffeur dwell) and ends no earlier than
-- ceil15(depart + route + drive(destination -> place)); applied only when the car is free for the longer window on the same local day.
-- A Sadran's manual placement (pin_reason SADRAN_MANUAL) is left as drawn. Idempotent.
create or replace function public.extend_chauffeur_pickup_drive(_car uuid, _week date) returns void
language plpgsql security definer
set search_path = public, pg_temp
as $$
declare
  v_dept uuid; v_turnaround interval; v_dwell int; c record;
  v_t1 int; v_t3 int; v_route int; v_start timestamptz; v_end timestamptz;
begin
  select department_id into v_dept from public.cars where id = _car;
  if v_dept is null then return; end if;
  v_turnaround := make_interval(mins => coalesce(public.required_turnaround_minutes(v_dept, _week), 30));
  select coalesce((w.settings_overrides ->> 'chauffeur_dwell_minutes')::int, s.chauffeur_dwell_minutes, 10) into v_dwell
  from public.department_settings s left join public.weeks w on w.department_id = s.department_id and w.week_start = _week
  where s.department_id = v_dept;
  v_dwell := greatest(coalesce(v_dwell, 10), 0);

  for c in
    select r.id as ride_id, r.starts_at, r.ends_at, r.origin_id as place, q.id as request_id, q.depart_at, q.origin_id, q.destination_id
    from public.rides r
    join public.ride_requests rr on rr.ride_id = r.id
    join public.requests q on q.id = rr.request_id
    where r.car_id = _car and r.week_start = _week and r.status <> 'cancelled' and not r.planning_conflict and not r.auto_relocation
      and r.pin_reason is distinct from 'SADRAN_MANUAL'
      and rr.car_mode = 'chauffeur' and rr.leg = 'out'
      and (select count(*) from public.ride_requests x where x.ride_id = r.id) = 1
      and q.origin_id is not null and q.destination_id is not null and q.depart_at is not null
      and r.origin_id is distinct from q.origin_id
    order by r.starts_at
  loop
    select p.travel_minutes into v_t1 from public.place_travel(c.place, c.origin_id) p;
    continue when v_t1 is null;
    select p.travel_minutes into v_t3 from public.place_travel(c.destination_id, c.place) p;
    v_route := greatest(coalesce(public.request_leg_route_minutes(c.request_id, 'out'), 30), 0);
    v_start := to_timestamp(floor(extract(epoch from (c.depart_at - make_interval(mins => v_t1 + v_dwell))) / 900) * 900);
    v_end := greatest(c.ends_at, to_timestamp(ceil(extract(epoch from (c.depart_at + make_interval(mins => v_route + coalesce(v_t3, 0)))) / 900) * 900));
    continue when c.starts_at <= v_start and c.ends_at >= v_end;
    v_start := least(v_start, c.starts_at);
    continue when (v_start at time zone 'Asia/Jerusalem')::date <> (c.starts_at at time zone 'Asia/Jerusalem')::date
      or ((v_end - interval '1 minute') at time zone 'Asia/Jerusalem')::date <> (c.starts_at at time zone 'Asia/Jerusalem')::date;
    continue when exists (
      select 1 from public.rides x
      where x.car_id = _car and x.id <> c.ride_id and x.status <> 'cancelled' and not x.planning_conflict
        and tstzrange(x.starts_at, x.blocked_until, '[)') && tstzrange(v_start, v_end + v_turnaround, '[)'))
      or exists (
      select 1 from public.car_maintenance_blocks b
      where b.car_id = _car and tstzrange(b.starts_at, b.ends_at, '[)') && tstzrange(v_start, v_end, '[)'));
    update public.rides set starts_at = v_start, ends_at = v_end where id = c.ride_id;
  end loop;
end $$;
revoke all on function public.extend_chauffeur_pickup_drive(uuid, date) from public;
