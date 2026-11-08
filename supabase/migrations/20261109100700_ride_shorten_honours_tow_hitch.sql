-- REQ §13.200 × §13.203: the make-room car list honours a towing request like auto-approve does
-- (`car_meets_needs`, the one waiver covering both needs) - written before towing existed.
create or replace function public._ride_shorten_car_fits(p_request_id uuid, p_car_id uuid)
returns boolean
language sql stable security definer set search_path = public, pg_temp as $$
  select exists (
    select 1
    from public.requests q
    join public.cars c on c.id = p_car_id and c.department_id = q.department_id
    join public.car_seat_configs csc on csc.car_id = c.id
    cross join lateral (select make_interval(mins => coalesce(public.required_turnaround_minutes(q.department_id, q.week_start), 30)) as buf) b
    where q.id = p_request_id and c.status = 'active' and c.type = 'shared'
      and csc.adults >= q.adults and csc.child_seats >= q.child_seats and csc.boosters >= q.boosters
      and public.car_meets_needs(c.id, case when q.has_luggage and q.luggage_waived_at is null then 1 else 0 end,
                                       case when q.needs_tow_hitch and q.luggage_waived_at is null then 1 else 0 end)
      and public.car_location_at(c.id, q.depart_at) = q.origin_id
      and coalesce(public.car_next_ride_origin(c.id, q.return_at), q.origin_id) = q.origin_id
      and not public._draft_hold_conflict(c.id, q.depart_at, q.return_at + b.buf, array[q.id])
      and not exists (select 1 from public.car_maintenance_blocks m
        where m.car_id = c.id and tstzrange(m.starts_at, m.ends_at, '[)') && tstzrange(q.depart_at, q.return_at + b.buf, '[)'))
      and not public.car_held_by_waitlist_group(c.id, q.depart_at, q.return_at + b.buf, q.id));
$$;
revoke all on function public._ride_shorten_car_fits(uuid, uuid) from public;
