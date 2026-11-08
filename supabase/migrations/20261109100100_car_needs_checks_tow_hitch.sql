-- REQ §13.200: the car-needs funnel (assert_ride_seats_fit, _small_trunk_check, _small_trunk_detail) learns the
-- towing need beside large luggage. One waivable error code (`needs_large_trunk`); its detail now says which
-- needs the car lacks (`needs`: 'large_trunk' / 'tow_hitch') and, when the car's hitch is already used by another
-- towing request on the ride, who (`tow_taken_by`).

create or replace function public._small_trunk_detail_for(p_request_ids uuid[], p_car_id uuid, p_ride_id uuid) returns text
language sql stable security definer set search_path = public, pg_temp as $$
  with ids as (
    select q.* from public.requests q where q.id = any(p_request_ids)
  ), car as (
    select c.id, ('tow_hitch' = any(c.features)) as has_hitch from public.cars c where c.id = p_car_id
  ), holder as (
    -- the towing request already riding on the ride (not one of the asked ones): it holds the one hitch
    select q.id, p.full_name from public.ride_requests rr
      join public.requests q on q.id = rr.request_id
      join public.profiles p on p.id = q.requester_id
     where p_ride_id is not null and rr.ride_id = p_ride_id and q.needs_tow_hitch and q.luggage_waived_at is null
       and q.id <> all (coalesce(p_request_ids, '{}'::uuid[]))
     order by rr.created_at, q.id limit 1
  )
  select jsonb_build_object(
    'request_ids', coalesce((select jsonb_agg(i.id order by i.id) from ids i), '[]'::jsonb),
    'names', coalesce((select jsonb_agg(p.full_name order by i.id) from ids i
                       join public.profiles p on p.id = i.requester_id), '[]'::jsonb),
    'car_id', p_car_id,
    'car_name', (select c.name from public.cars c where c.id = p_car_id),
    'needs', to_jsonb(array_remove(array[
        case when exists (select 1 from ids i where i.has_luggage and i.luggage_waived_at is null)
              and not public.car_takes_luggage(p_car_id, 1) then 'large_trunk' end,
        case when exists (select 1 from ids i where i.needs_tow_hitch and i.luggage_waived_at is null)
              and (not coalesce((select has_hitch from car), false) or exists (select 1 from holder)) then 'tow_hitch' end
      ], null)),
    'tow_taken_by', case when coalesce((select has_hitch from car), false) then (select full_name from holder) end)::text;
$$;
revoke all on function public._small_trunk_detail_for(uuid[], uuid, uuid) from public, anon, authenticated;

create or replace function public._small_trunk_detail(p_request_ids uuid[], p_car_id uuid) returns text
language sql stable security definer set search_path = public, pg_temp as $$
  select public._small_trunk_detail_for(p_request_ids, p_car_id, null);
$$;

create or replace function public._small_trunk_check(p_request_ids uuid[], p_car_id uuid, p_allow boolean) returns void
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare v_ids uuid[]; v_lug int; v_tow int;
begin
  if coalesce(p_allow, false) or p_car_id is null then return; end if;
  select array_agg(q.id order by q.id),
         count(*) filter (where q.has_luggage and q.luggage_waived_at is null),
         count(*) filter (where q.needs_tow_hitch and q.luggage_waived_at is null)
    into v_ids, v_lug, v_tow
  from public.requests q
  where q.id = any(p_request_ids)
    and ((q.has_luggage or q.needs_tow_hitch) and q.luggage_waived_at is null);
  if v_ids is null then return; end if;
  -- the ids may be several days of a series (different rides): the one-hitch-per-ride cap is the ride check's business
  if public.car_meets_needs(p_car_id, v_lug, least(v_tow, 1)) then return; end if;
  raise exception 'needs_large_trunk' using errcode = 'P0001', detail = public._small_trunk_detail(v_ids, p_car_id);
end $$;

create or replace function public.assert_ride_seats_fit(v_ride uuid) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare r record; v_mode text; v_ids uuid[]; v_holder uuid; v_hitch boolean; v_lug_ok boolean;
begin
  v_mode := coalesce(current_setting('app.small_trunk', true), '');
  for r in
    select leg_side,
           sum(q.adults) a, sum(q.child_seats) c, sum(q.boosters) b, rd.car_id,
           count(*) filter (where q.has_luggage and q.luggage_waived_at is null) lug,
           count(*) filter (where q.needs_tow_hitch and q.luggage_waived_at is null) tow
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
    if not public.car_meets_needs(r.car_id, r.lug::int, r.tow::int) then
      v_lug_ok := public.car_takes_luggage(r.car_id, r.lug::int);
      v_hitch := exists (select 1 from public.cars c where c.id = r.car_id and 'tow_hitch' = any(c.features));
      -- the towing request that already holds the one hitch (the oldest on the ride): the others are the ones in question
      select q.id into v_holder
      from public.ride_requests rr join public.requests q on q.id = rr.request_id
      where rr.ride_id = v_ride and q.needs_tow_hitch and q.luggage_waived_at is null
        and ((r.leg_side = 'out' and rr.covers_out) or (r.leg_side = 'return' and rr.covers_return))
      order by rr.created_at, q.id limit 1;
      select array_agg(distinct q.id order by q.id) into v_ids
      from public.ride_requests rr join public.requests q on q.id = rr.request_id
      where rr.ride_id = v_ride and q.luggage_waived_at is null
        and ((r.leg_side = 'out' and rr.covers_out) or (r.leg_side = 'return' and rr.covers_return))
        and ((q.has_luggage and not v_lug_ok)
             or (q.needs_tow_hitch and (not v_hitch or q.id is distinct from v_holder)));
      if v_mode = 'allow' then
        -- the person placing by hand accepted a car without what these requests need (large trunk / hitch)
        update public.requests set luggage_waived_at = now(), luggage_waived_by = (select auth.uid())
        where id = any(v_ids) and luggage_waived_at is null;
      elsif v_mode = 'ask' then
        raise exception 'needs_large_trunk' using errcode = 'P0001', detail = public._small_trunk_detail_for(v_ids, r.car_id, v_ride);
      else
        raise exception 'luggage_capacity_violation' using errcode = 'P0001', detail =
          format('ride %s leg %s carries %s large-luggage and %s towing request(s)', v_ride, r.leg_side, r.lug, r.tow);
      end if;
    end if;
  end loop;
end $$;
