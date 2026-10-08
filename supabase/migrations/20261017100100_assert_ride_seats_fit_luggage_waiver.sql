-- REQ §13.111 (a): assert_ride_seats_fit counts only the large-luggage requests that still need a large
-- trunk (a waived one does not), and - when a manual RPC set `app.small_trunk` - waives or asks instead of
-- raising luggage_capacity_violation (see 20261017100000).

create or replace function public.assert_ride_seats_fit(v_ride uuid) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare r record; v_mode text; v_ids uuid[];
begin
  v_mode := coalesce(current_setting('app.small_trunk', true), '');
  for r in
    select leg_side,
           sum(q.adults) a, sum(q.child_seats) c, sum(q.boosters) b, rd.car_id,
           count(*) filter (where q.has_luggage and q.luggage_waived_at is null) lug
    from public.ride_requests rr
    join public.requests q on q.id = rr.request_id
    join public.rides rd on rd.id = rr.ride_id
    cross join lateral (values ('out'), ('return')) as legs(leg_side)
    where rr.ride_id = v_ride and rd.status <> 'cancelled'
      and ((legs.leg_side = 'out' and rr.covers_out) or (legs.leg_side = 'return' and rr.covers_return))
    group by leg_side, rd.car_id
  loop
    if not exists (select 1 from public.ride_requests x where x.ride_id = v_ride and x.role = 'driver')
      and not exists (select 1 from public.ride_requests x join public.requests q on q.id=x.request_id join public.rides rd on rd.id=x.ride_id
        where x.ride_id=v_ride and q.requester_id=rd.driver_id and ((r.leg_side='out' and x.covers_out) or (r.leg_side='return' and x.covers_return))) then
      r.a := r.a + 1;   -- chauffeur ride: the volunteer has no request of their own (§5.2)
    end if;
    if not public.car_fits(r.car_id, r.a::int, r.c::int, r.b::int) then
      raise exception 'seat_config_violation' using detail =
        format('ride %s leg %s needs (%s,%s,%s)', v_ride, r.leg_side, r.a, r.c, r.b);
    end if;
    if not public.car_takes_luggage(r.car_id, r.lug::int) then
      select array_agg(distinct q.id order by q.id) into v_ids
      from public.ride_requests rr join public.requests q on q.id = rr.request_id
      where rr.ride_id = v_ride and q.has_luggage and q.luggage_waived_at is null
        and ((r.leg_side = 'out' and rr.covers_out) or (r.leg_side = 'return' and rr.covers_return));
      if v_mode = 'allow' then
        -- the person placing by hand accepted a car without a large trunk for these requests
        update public.requests set luggage_waived_at = now(), luggage_waived_by = (select auth.uid())
        where id = any(v_ids) and luggage_waived_at is null;
      elsif v_mode = 'ask' then
        raise exception 'needs_large_trunk' using errcode = 'P0001', detail = public._small_trunk_detail(v_ids, r.car_id);
      else
        raise exception 'luggage_capacity_violation' using errcode = 'P0001', detail =
          format('ride %s leg %s carries %s large-luggage request(s)', v_ride, r.leg_side, r.lug);
      end if;
    end if;
  end loop;
end $$;
