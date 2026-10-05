-- REQ §13.93/§13.96: publication conflicts check a car's chain against where the car actually is
-- (previous non-reservation ride's destination, else car_base_location), never the department home.
-- The away-at-day-end clause (overnight_ack_by, deprecated) is gone. Replaces 20261005160700.

create or replace function public.publication_conflicting_ride_ids(p_department_id uuid, p_week_start date, p_days date[]) returns setof uuid
    language plpgsql stable security definer
    set search_path = public, pg_temp
    as $$
declare r record; here uuid; bad boolean; res boolean;
begin
  for r in
    select * from public.rides where department_id=p_department_id and week_start=p_week_start and status<>'cancelled'
      and (starts_at at time zone 'Asia/Jerusalem')::date=any(p_days)
  loop
    res:=public.ride_is_reservation(r.id);
    bad:=r.starts_at>=r.ends_at or (r.starts_at at time zone 'Asia/Jerusalem')::date<>(r.ends_at at time zone 'Asia/Jerusalem')::date
      or (r.ends_at at time zone 'Asia/Jerusalem')::time>'23:59'::time
      or (r.starts_at at time zone 'Asia/Jerusalem')::date not between p_week_start and p_week_start+6;
    bad:=bad or exists(select 1 from public.rides other where other.id<>r.id and other.status<>'cancelled'
      and (other.car_id=r.car_id or (r.driver_id is not null and other.driver_id=r.driver_id))
      and tstzrange(other.starts_at,other.ends_at,'[)') && tstzrange(r.starts_at,r.ends_at,'[)'));
    bad:=bad or exists(select 1 from public.car_maintenance_blocks b where b.car_id=r.car_id
      and tstzrange(b.starts_at,b.ends_at,'[)') && tstzrange(r.starts_at,r.ends_at,'[)'));
    bad:=bad or not exists(select 1 from public.cars c where c.id=r.car_id and c.department_id=p_department_id and c.status='active');
    if not res then
      here:=coalesce((select prev.destination_id from public.rides prev
        where prev.car_id=r.car_id and prev.status<>'cancelled' and (prev.starts_at,prev.id)<(r.starts_at,r.id)
          and not public.ride_is_reservation(prev.id)
        order by prev.starts_at desc,prev.id desc limit 1),public.car_base_location(r.car_id));
      bad:=bad or r.origin_id is distinct from here;
    end if;
    bad:=bad or (not res and exists(select 1 from public.rides following where following.id=(select nxt.id from public.rides nxt
      where nxt.car_id=r.car_id and nxt.week_start=p_week_start and nxt.status<>'cancelled' and (nxt.starts_at,nxt.id)>(r.starts_at,r.id)
        and not public.ride_is_reservation(nxt.id)
      order by nxt.starts_at,nxt.id limit 1) and following.origin_id is distinct from r.destination_id));
    begin
      perform public.assert_ride_request_day(r.id);
      perform public.assert_ride_driver(r.id);
      perform public.assert_ride_seats_fit(r.id);
    exception when raise_exception or check_violation then bad:=true;
    end;
    if bad then return next r.id;end if;
  end loop;
  -- 1020 adds private provisional shadows. JSON access keeps this migration
  -- applicable first, while making pending provisional edits a hard blocker.
  return query select distinct c.ride_id from public.ride_change_requests c
    where c.department_id=p_department_id and c.week_start=p_week_start and c.status='pending'
      and coalesce((to_jsonb(c)->>'is_planning')::boolean,false)
      and (c.starts_at at time zone 'Asia/Jerusalem')::date=any(p_days);
end;
$$;
