-- F5 (docs/TODO.md "Solver: spread rides across cars to balance mileage";
-- owner A11 2026-09-14: a rolling window, not "this week only"). Per-car
-- rolling mileage total, fed into the solver via buildSolverInput()
-- (Car.mileageKm) so a tie between otherwise-equally-acceptable cars favors
-- the less-driven one (docs/SOLVER.md §3.6.2, REQUIREMENTS §13.84).
--
-- A ride's own origin_id/destination_id are almost always home (the far
-- point of a round trip lives on the *served request*, not the ride —
-- DATA_MODEL.md §3.7 `rides`), so distance is read off the ride's served
-- request (the driver's request, or any served request for a driverless
-- chauffeur leg) via `ride_requests`/`requests`.`destination_id` ->
-- `destinations.distance_km` (0 when unknown/free-text). A round trip
-- (origin_id = destination_id, i.e. parked home both ends) counts double;
-- a one-way relay leg (origin_id <> destination_id) counts once — its
-- partner leg is its own ride row, already counted once, so a relay pair
-- totals the same 2x as a round trip.
--
-- Window: non-cancelled rides in the `p_weeks` weeks strictly before
-- `p_week_start`, plus `p_week_start` itself but only its already-`confirmed`
-- rides (a solve in progress for the week being solved must not count its
-- own not-yet-applied draft). Callable by any department member (unlike
-- `fairness_stats`, which is Sadran/admin-only) — mileage is not sensitive.
create or replace function public.car_mileage_totals(p_department_id uuid, p_week_start date, p_weeks int default 4)
returns table (car_id uuid, km numeric)
security definer set search_path = public, pg_temp language plpgsql as $$
begin
  if not public.member_of(p_department_id) then
    raise exception 'not_authorized' using errcode = 'P0001';
  end if;

  return query
    select c.id,
      coalesce(sum(
        coalesce(dest.distance_km, 0)
        * case when r.origin_id = r.destination_id then 2 else 1 end
      ), 0)::numeric as km
    from public.cars c
    left join public.rides r
      on r.car_id = c.id
      and r.status <> 'cancelled'
      and r.week_start >= p_week_start - (p_weeks * 7)
      and r.week_start <= p_week_start
      and (r.week_start < p_week_start or r.status = 'confirmed')
    left join lateral (
      select rq.request_id
      from public.ride_requests rq
      where rq.ride_id = r.id
      order by case when rq.role = 'driver' then 0 else 1 end, rq.request_id
      limit 1
    ) served on true
    left join public.requests req on req.id = served.request_id
    left join public.destinations dest on dest.id = req.destination_id
    where c.department_id = p_department_id and c.type = 'shared' and c.status = 'active'
    group by c.id;
end;
$$;

revoke execute on function public.car_mileage_totals(uuid, date, int) from public, anon;
grant execute on function public.car_mileage_totals(uuid, date, int) to authenticated;
