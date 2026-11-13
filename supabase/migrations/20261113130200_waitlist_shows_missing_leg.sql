-- R19B6 (QA run 19, owner 2026-11-13, REQ item 222): a round trip with one leg on a ride (placed or merged) and the
-- other leg on no ride still needs that leg. The siddur's "חסר רכב" columns now show that leg — at its own hours, with
-- `missing_leg` = 'out' / 'return' — instead of hiding the request (REQ §13.182 a amended). Not draggable (the drop
-- places a whole round trip); the Sadran places it from the board, where the leg is unmet already (RC1B2).
-- New output column: the function is dropped and created again (same name and arguments).
drop function public.siddur_waitlist(uuid, date);

create function public.siddur_waitlist(p_department_id uuid, p_week_start date)
returns table(request_id uuid, requester_id uuid, requester_name text, companion_names text[], child_names text[], guest_names text[],
  adults smallint, child_seats smallint, boosters smallint, trip_type public.trip_type, depart_at timestamptz, return_at timestamptz,
  starts_at timestamptz, ends_at timestamptz, day date, origin_name text, origin_is_home boolean, destination_name text,
  is_mine boolean, version integer, missing_leg text)
language plpgsql stable security definer
set search_path = public, pg_temp
as $$
declare v_uid uuid := (select auth.uid());
begin
  if not (public.member_of(p_department_id) or public.is_admin()) then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  return query
  with cover as (
    select rr.request_id, bool_or(rr.covers_out) as has_out, bool_or(rr.covers_return) as has_ret
    from public.ride_requests rr join public.rides r on r.id = rr.ride_id
    where r.department_id = p_department_id and r.week_start = p_week_start and r.status <> 'cancelled'
    group by rr.request_id
  ), w as (
    select q.*, coalesce(d.travel_minutes, 60) as travel,
           ((coalesce(q.depart_at, q.return_at)) at time zone 'Asia/Jerusalem')::date as q_day,
           case when q.status = 'waitlisted' then null
                when c.has_out then 'return' else 'out' end as missing
    from public.requests q
    left join public.destinations d on d.id = q.destination_id
    left join cover c on c.request_id = q.id
    where q.department_id = p_department_id and q.week_start = p_week_start and q.join_ride_id is null
      and not exists (select 1 from public.waitlist_group_members gm join public.waitlist_groups g on g.id = gm.group_id
                      where gm.request_id = q.id and g.status = 'open')
      and (
        (q.status = 'waitlisted' and c.request_id is null)
        -- R19B6: a two-leg round trip with exactly one leg on a ride
        or (q.status in ('assigned', 'merged') and q.series_id is null and q.trip_type = 'round_trip'
            and q.depart_at is not null and q.return_at is not null
            and c.request_id is not null and c.has_out is distinct from c.has_ret)
      ))
  select w.id, w.requester_id, p.full_name,
    coalesce((select array_agg(cp.full_name order by cp.full_name) from public.request_companions c
              join public.profiles cp on cp.id = c.profile_id where c.request_id = w.id), '{}'),
    coalesce((select array_agg(ch.full_name order by ch.full_name) from public.request_children rc
              join public.children ch on ch.id = rc.child_id where rc.request_id = w.id), '{}'),
    w.guest_passenger_names,
    w.adults, w.child_seats, w.boosters, w.trip_type, w.depart_at, w.return_at,
    case w.missing when 'return' then w.return_at - make_interval(mins => w.travel)
                   else coalesce(w.depart_at, w.return_at - make_interval(mins => w.travel)) end,
    case w.missing when 'out' then w.depart_at + make_interval(mins => w.travel)
                   else coalesce(w.return_at, w.depart_at + make_interval(mins => w.travel)) end,
    case when w.missing = 'return' then (w.return_at at time zone 'Asia/Jerusalem')::date else w.q_day end,
    coalesce(o.name, nullif(w.origin_text, ''), home.name),
    (w.origin_id is null and nullif(w.origin_text, '') is null) or w.origin_id = dep.home_destination_id,
    coalesce(dd.name, w.destination_text),
    (w.requester_id = v_uid or w.filed_by = v_uid),
    w.version,
    w.missing
  from w
  join public.profiles p on p.id = w.requester_id
  left join public.destinations o on o.id = w.origin_id
  left join public.destinations dd on dd.id = w.destination_id
  left join public.departments dep on dep.id = w.department_id
  left join public.destinations home on home.id = dep.home_destination_id
  where public.is_day_public(p_department_id, p_week_start, w.q_day)
  order by 13, w.id;
end $$;

revoke all on function public.siddur_waitlist(uuid, date) from public;
grant execute on function public.siddur_waitlist(uuid, date) to authenticated;
grant all on function public.siddur_waitlist(uuid, date) to service_role;
