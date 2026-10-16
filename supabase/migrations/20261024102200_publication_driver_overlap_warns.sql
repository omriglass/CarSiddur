-- REQ §13 (owner 2026-10-16): the same driver on two overlapping rides is a warning, never a publication blocker.
-- Full redefinition of publication_conflict_details without the driver_overlap branch.
create or replace function public.publication_conflict_details(p_department_id uuid, p_week_start date, p_days date[])
 returns table(ride_id uuid, reason text, other_ride_id uuid)
 language plpgsql stable security definer set search_path to 'public', 'pg_temp'
as $$
declare r record; here uuid; res boolean; o uuid; nxt uuid;
begin
  for r in
    select * from public.rides where department_id=p_department_id and week_start=p_week_start and status<>'cancelled'
      and (starts_at at time zone 'Asia/Jerusalem')::date=any(p_days)
  loop
    res:=public.ride_is_reservation(r.id);
    ride_id:=r.id; other_ride_id:=null;
    if r.starts_at>=r.ends_at or (r.starts_at at time zone 'Asia/Jerusalem')::date<>(r.ends_at at time zone 'Asia/Jerusalem')::date
      or (r.ends_at at time zone 'Asia/Jerusalem')::time>'23:59'::time
      or (r.starts_at at time zone 'Asia/Jerusalem')::date not between p_week_start and p_week_start+6 then
      reason:='bad_window'; other_ride_id:=null; return next;
    end if;
    select other.id into o from public.rides other where other.id<>r.id and other.status<>'cancelled' and other.car_id=r.car_id
      and tstzrange(other.starts_at,other.ends_at,'[)') && tstzrange(r.starts_at,r.ends_at,'[)') order by other.starts_at limit 1;
    if o is not null then reason:='car_overlap'; other_ride_id:=o; return next; end if;
    other_ride_id:=null;
    if exists(select 1 from public.car_maintenance_blocks b where b.car_id=r.car_id
      and tstzrange(b.starts_at,b.ends_at,'[)') && tstzrange(r.starts_at,r.ends_at,'[)')) then reason:='maintenance'; return next; end if;
    if not exists(select 1 from public.cars c where c.id=r.car_id and c.department_id=p_department_id and c.status='active') then
      reason:='car_unavailable'; return next;
    end if;
    if not res then
      select prev.id, prev.destination_id into o, here from public.rides prev
        where prev.car_id=r.car_id and prev.status<>'cancelled' and (prev.starts_at,prev.id)<(r.starts_at,r.id)
          and not public.ride_is_reservation(prev.id)
        order by prev.starts_at desc,prev.id desc limit 1;
      if o is null then here:=public.car_base_location(r.car_id); end if;
      if r.origin_id is distinct from here then reason:='car_not_at_origin'; other_ride_id:=o; return next; end if;
      other_ride_id:=null;
      select nx.id into nxt from public.rides nx
        where nx.car_id=r.car_id and nx.week_start=p_week_start and nx.status<>'cancelled' and (nx.starts_at,nx.id)>(r.starts_at,r.id)
          and not public.ride_is_reservation(nx.id)
        order by nx.starts_at,nx.id limit 1;
      if nxt is not null and exists(select 1 from public.rides f where f.id=nxt and f.origin_id is distinct from r.destination_id) then
        reason:='next_ride_not_here'; other_ride_id:=nxt; return next; other_ride_id:=null;
      end if;
    end if;
    begin perform public.assert_ride_request_day(r.id);
    exception when raise_exception or check_violation then reason:='request_day'; return next; end;
    begin perform public.assert_ride_driver(r.id);
    exception when raise_exception or check_violation then reason:='driver'; return next; end;
    begin perform public.assert_ride_seats_fit(r.id);
    exception when raise_exception or check_violation then reason:='seats'; return next; end;
  end loop;
  -- pending provisional (planning) edits on a live ride block too; a cancelled ride's shadow is not a ride to show.
  return query select distinct c.ride_id, 'planning_edit'::text, null::uuid from public.ride_change_requests c
    join public.rides rr on rr.id=c.ride_id and rr.status<>'cancelled'
    where c.department_id=p_department_id and c.week_start=p_week_start and c.status='pending'
      and coalesce((to_jsonb(c)->>'is_planning')::boolean,false)
      and (c.starts_at at time zone 'Asia/Jerusalem')::date=any(p_days);
end;
$$;

