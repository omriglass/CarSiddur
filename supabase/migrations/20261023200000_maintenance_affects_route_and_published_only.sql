-- R12B2 (QA run 12): `maintenance_affects` said "הנסיעה שלך ל ביום ..." (no destination: the notice carried only the
-- ride id, so `notification_context` had no request to build the route from) and went to members for rides on
-- unpublished days. The route is now filled (the served request's route label, else the ride's own places) and the
-- driver is told only when the ride's day is public; the Sadranim still always get it.
-- Full `create or replace`, copied from supabase/schema-current.sql; only the route var and the published check changed.

create or replace function public.flag_rides_in_maintenance() returns trigger
    language plpgsql security definer
    set search_path to 'public', 'pg_temp'
as $$
declare
  v_ride record;
  v_sadran_id uuid;
  v_req uuid;
  v_route text;
begin
  for v_ride in
    select r.id, r.department_id, r.week_start, r.driver_id, r.starts_at, r.origin_id, r.destination_id
    from public.rides r
    where r.car_id = new.car_id and r.status not in ('cancelled','flagged')
      and tstzrange(r.starts_at, r.blocked_until, '[)') && tstzrange(new.starts_at, new.ends_at, '[)')
  loop
    update public.rides set status = 'flagged', flag_reason = 'maintenance' where id = v_ride.id;
    select rr.request_id into v_req from public.ride_requests rr where rr.ride_id = v_ride.id
      order by rr.created_at, rr.request_id limit 1;
    if v_req is not null then
      v_route := public.request_route_label(v_req);
    else
      v_route := public.route_label(v_ride.department_id, v_ride.origin_id, null, v_ride.destination_id, null);
    end if;
    if v_ride.driver_id is not null
       and public.is_day_public(v_ride.department_id, v_ride.week_start, (v_ride.starts_at at time zone 'Asia/Jerusalem')::date) then
      perform public.enqueue_notification(v_ride.driver_id, 'maintenance_affects', v_ride.department_id, v_ride.week_start,
        jsonb_build_object('route', coalesce(v_route, '')), jsonb_build_object('ride_id', v_ride.id),
        format('maintenance_affects:%s:%s', v_ride.id, new.id));
    end if;
    for v_sadran_id in select * from public.sadranim_of(v_ride.department_id, v_ride.week_start) loop
      perform public.enqueue_notification(v_sadran_id, 'maintenance_affects', v_ride.department_id, v_ride.week_start,
        jsonb_build_object('route', coalesce(v_route, '')), jsonb_build_object('ride_id', v_ride.id),
        format('maintenance_affects:%s:%s:%s', v_ride.id, new.id, v_sadran_id));
    end loop;
  end loop;
  return new;
end;
$$;
