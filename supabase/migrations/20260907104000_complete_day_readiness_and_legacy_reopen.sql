-- Readiness needs every requested leg, not merely any assignment.
create or replace function public.publication_readiness(p_department_id uuid,p_week_start date) returns jsonb
language plpgsql stable security definer set search_path=public,pg_temp as $$
declare result jsonb:='[]'; d date; requests_n int; unresolved_n int; pending_n int; missing_n int; conflicts_n int;
begin
  if not public.can_manage_week(p_department_id,p_week_start) then raise exception 'not_authorized';end if;
  for d in select p_week_start+i from generate_series(0,6) i loop
    select count(*),count(*) filter(where q.status in ('submitted','waitlisted','proposed')
      or (q.status in ('assigned','merged') and not (
        (q.trip_shape='one_way_from' or exists(select 1 from public.ride_requests rr join public.rides r on r.id=rr.ride_id
          where rr.request_id=q.id and rr.covers_out and r.status<>'cancelled' and not r.needs_driver))
        and (q.trip_shape='one_way_to' or exists(select 1 from public.ride_requests rr join public.rides r on r.id=rr.ride_id
          where rr.request_id=q.id and rr.covers_return and r.status<>'cancelled' and not r.needs_driver))
      )))
    into requests_n,unresolved_n from public.requests q where q.department_id=p_department_id and q.week_start=p_week_start
      and q.status not in ('draft','withdrawn','cancelled') and (coalesce(q.depart_at,q.return_at) at time zone 'Asia/Jerusalem')::date=d;
    select count(*) into pending_n from public.proposals p join public.requests q on q.id=p.request_id
      where p.department_id=p_department_id and p.week_start=p_week_start and p.status in ('draft','sent','accepted')
        and ((coalesce(q.depart_at,q.return_at) at time zone 'Asia/Jerusalem')::date=d
          or exists(select 1 from public.rides r where r.id=p.ride_id and (r.starts_at at time zone 'Asia/Jerusalem')::date=d));
    pending_n:=pending_n+(select count(*) from public.ride_change_requests c where c.department_id=p_department_id and c.week_start=p_week_start
      and c.status='pending' and (c.starts_at at time zone 'Asia/Jerusalem')::date=d);
    select count(*) into missing_n from public.rides r where r.department_id=p_department_id and r.week_start=p_week_start
      and r.status<>'cancelled' and r.needs_driver and (r.starts_at at time zone 'Asia/Jerusalem')::date=d;
    select count(distinct id) into conflicts_n from public.publication_conflicting_ride_ids(p_department_id,p_week_start,array[d]) id;
    result:=result||jsonb_build_array(jsonb_build_object('day',d,'published',public.is_day_public(p_department_id,p_week_start,d),
      'requestCount',requests_n,'unresolvedRequests',unresolved_n,'pendingProposals',pending_n,'missingDriverRides',missing_n,'conflictRides',conflicts_n,
      'ready',unresolved_n=0 and pending_n=0 and missing_n=0 and conflicts_n=0));
  end loop;
  return result;
end;
$$;

-- Reopening can demote a legacy booking without changing its historical window.
-- Publishing it again or changing its schedule still requires current invariants.
create or replace function public.rides_within_week() returns trigger
language plpgsql set search_path=public,pg_temp as $$
begin
  if tg_op='UPDATE' and new.starts_at=old.starts_at and new.ends_at=old.ends_at and new.week_start=old.week_start
    and new.car_id=old.car_id and (new.status=old.status or (new.status='draft' and old.status in ('confirmed','flagged'))) then return new;end if;
  if new.status='cancelled' then return new;end if;
  perform public.assert_same_day_window(new.starts_at,new.ends_at);
  if not (public.week_range(new.week_start) @> tstzrange(new.starts_at,new.ends_at,'[)')) then raise exception 'ride_outside_week';end if;
  return new;
end $$;

-- Keep the prior ability to inspect cancelled history on an explicitly public
-- day. Draft/unpublished assignments stay private; calendar APIs omit cancellations.
drop policy rides_select on public.rides;
create policy rides_select on public.rides for select to authenticated using (
  public.can_manage_week(department_id,week_start)
  or (public.is_approved() and status<>'draft'
    and public.is_day_public(department_id,week_start,(starts_at at time zone 'Asia/Jerusalem')::date))
);
