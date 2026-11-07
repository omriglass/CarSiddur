-- Owner 2026-11-07 (REQ §13.186 c): the car swap dialog names one person per ride ("18:00 אגתה לתל יצחק"),
-- not only its time and destination. `person_name` = the driver, else the first rider who asked for it,
-- else the first person named on a reservation.
create or replace function public._day_car_swap_rides_json(p_ride_ids uuid[])
returns jsonb
language sql stable security definer
set search_path = public, pg_temp
as $$
  select coalesce(jsonb_agg(jsonb_build_object(
      'ride_id', rd.id, 'car_id', rd.car_id, 'starts_at', rd.starts_at, 'ends_at', rd.ends_at,
      'driver_name', p.full_name, 'label', dst.name,
      'person_name', coalesce(p.full_name, rq.full_name, rp.display_name),
      'series_id', q.series_id, 'series_index', q.series_index, 'series_count', q.series_count
    ) order by rd.starts_at), '[]'::jsonb)
  from public.rides rd
  left join public.profiles p on p.id = rd.driver_id
  left join public.destinations dst on dst.id = rd.destination_id
  left join lateral (
    select q1.series_id, q1.series_index, q1.series_count
    from public.ride_requests rr1 join public.requests q1 on q1.id = rr1.request_id
    where rr1.ride_id = rd.id and q1.series_id is not null limit 1
  ) q on true
  left join lateral (
    select pr.full_name
    from public.ride_requests rr2
    join public.requests q2 on q2.id = rr2.request_id
    join public.profiles pr on pr.id = q2.requester_id
    where rr2.ride_id = rd.id
    order by rr2.created_at, rr2.request_id limit 1
  ) rq on true
  left join lateral (
    select rp1.display_name from public.ride_passengers rp1
    where rp1.ride_id = rd.id order by rp1.created_at, rp1.id limit 1
  ) rp on true
  where rd.id = any(p_ride_ids);
$$;

revoke execute on function public._day_car_swap_rides_json(uuid[]) from public, anon, authenticated;
