-- Silent drops item 3 (owner 2026-11-24): a rider who gets on / off at a place on the way (REQ item 246 h:
-- `ride_passengers` places, `request_rider_stops`) silently became a whole-way rider when that place left the route
-- (the trip's owner removed the stop, the Sadran edited the route, or the guest whose place it was left).
--  * _off_route_riders(ride, removed): the riders whose stated place is not on the ride's route - the current one, or
--    the route with the given points taken out ([{leg, place_id | place_text}], one point per entry).
--  * riders_losing_places(ride, removed): granted; the riders a change would newly take off the route, for the
--    "ask first" question of the person making it (a guest leaving or taken off). The request form's own edit already
--    asks and clears the riders' places in submit_request (`riders_off_route`, REQ item 246 h) - unchanged.
--  * the rider is told once per (ride, rider, place) after any change that takes their place off the route
--    (`rider_off_route` constraint triggers, deferred to the end of the transaction), outcome_changed variant
--    `rider_place_off_route`; ride_stretches() gains `off_route` for the orange mark in the people list.

create or replace function public._off_route_riders(p_ride_id uuid, p_removed jsonb default '[]'::jsonb)
returns table(rider_key text, request_id uuid, name text, leg public.ride_leg, place text, recipients uuid[])
language sql stable security definer set search_path = public, pg_temp as $$
  with route as (
    select r.leg, coalesce(r.place_id::text, 't:' || lower(btrim(r.place_text))) as k,
           row_number() over (partition by r.leg, coalesce(r.place_id::text, 't:' || lower(btrim(r.place_text))) order by r."position") as rn
    from public._ride_route(p_ride_id) r),
  removed as (
    select (e ->> 'leg')::public.ride_leg as leg,
           coalesce(nullif(e ->> 'place_id', ''), 't:' || lower(btrim(e ->> 'place_text'))) as k, count(*) as n
    from jsonb_array_elements(coalesce(p_removed, '[]'::jsonb)) e
    where e ->> 'leg' in ('out', 'return') and coalesce(nullif(e ->> 'place_id', ''), nullif(btrim(e ->> 'place_text'), '')) is not null
    group by 1, 2),
  kept as (
    select r.leg, r.k from route r left join removed x on x.leg = r.leg and x.k = r.k
    where r.rn > coalesce(x.n, 0)),
  places as (
    -- riders added to the ride: a both-ways row keeps the way there's places in board/alight, the way back's in return_*
    select 'added:' || rp.id as rider_key, null::uuid as request_id, rp.display_name as name, x.leg, x.pid, x.ptext,
           array_remove(array[rp.person_id, rp.added_by], null)
             || coalesce((select array_agg(cg.profile_id) from public.child_guardians cg where cg.child_id = rp.child_id), '{}'::uuid[]) as recipients
    from public.ride_passengers rp
    cross join lateral (values
      (case when rp.leg = 'return' then 'return' else 'out' end::public.ride_leg, rp.board_place_id, rp.board_place_text),
      (case when rp.leg = 'return' then 'return' else 'out' end::public.ride_leg, rp.alight_place_id, rp.alight_place_text),
      ('return'::public.ride_leg, case when rp.leg = 'both' then rp.return_board_place_id end, case when rp.leg = 'both' then rp.return_board_place_text end),
      ('return'::public.ride_leg, case when rp.leg = 'both' then rp.return_alight_place_id end, case when rp.leg = 'both' then rp.return_alight_place_text end)
    ) x(leg, pid, ptext)
    where rp.ride_id = p_ride_id
    union all
    -- a request's own riders (companions, children, named guests) on the directions this ride carries for it
    select s.rider_key, s.request_id,
           case split_part(s.rider_key, ':', 1)
             when 'companion' then (select p.full_name from public.profiles p where p.id::text = split_part(s.rider_key, ':', 2))
             when 'child' then (select c.full_name from public.children c where c.id::text = split_part(s.rider_key, ':', 2))
             else q.guest_passenger_names[nullif(split_part(s.rider_key, ':', 2), '')::int] end,
           s.leg, x.pid, x.ptext,
           array_remove(array[q.requester_id,
             case when split_part(s.rider_key, ':', 1) = 'companion' then nullif(split_part(s.rider_key, ':', 2), '')::uuid end], null)
             || case when split_part(s.rider_key, ':', 1) = 'child'
                     then coalesce((select array_agg(cg.profile_id) from public.child_guardians cg
                                    where cg.child_id::text = split_part(s.rider_key, ':', 2)), '{}'::uuid[]) else '{}'::uuid[] end
    from public.request_rider_stops s
    join public.requests q on q.id = s.request_id
    cross join lateral (values (s.board_place_id, s.board_place_text), (s.alight_place_id, s.alight_place_text)) x(pid, ptext)
    where s.rides
      and exists (select 1 from public.ride_requests rr where rr.ride_id = p_ride_id and rr.request_id = s.request_id
                  and ((s.leg = 'out' and rr.covers_out) or (s.leg = 'return' and rr.covers_return))))
  select p.rider_key, p.request_id, p.name, p.leg, coalesce(d.name, p.ptext), p.recipients
  from places p left join public.destinations d on d.id = p.pid
  where coalesce(p.pid::text, nullif(btrim(p.ptext), '')) is not null
    and not exists (select 1 from kept r where r.leg = p.leg
                    and r.k = coalesce(p.pid::text, 't:' || lower(btrim(p.ptext))));
$$;
revoke all on function public._off_route_riders(uuid, jsonb) from public;

-- The "ask first" question: who would newly lose their place if these route points went. Whoever may change the
-- ride (related, or its week's Sadran) may ask; anyone else gets nothing.
create or replace function public.riders_losing_places(p_ride_id uuid, p_removed jsonb)
returns table(name text, place text) language sql stable security definer set search_path = public, pg_temp as $$
  select distinct a.name, a.place
  from public._off_route_riders(p_ride_id, p_removed) a
  join public.rides r on r.id = p_ride_id
  where (public.ride_related(p_ride_id, (select auth.uid())) or public.can_manage_week(r.department_id, r.week_start))
    and not exists (select 1 from public._off_route_riders(p_ride_id, '[]'::jsonb) b
                    where b.rider_key = a.rider_key and b.leg = a.leg and b.place = a.place)
  order by a.place, a.name;
$$;
revoke all on function public.riders_losing_places(uuid, jsonb) from public;
grant execute on function public.riders_losing_places(uuid, jsonb) to authenticated;

-- The orange mark in a ride's people list (REQ item 267 f): the people-list key of each rider off the route.
create or replace function public.ride_off_route_marks(p_ride_id uuid)
returns table(person_key text, leg public.ride_leg, place text) language sql stable security definer
set search_path = public, pg_temp as $$
  select distinct case when o.request_id is null then o.rider_key
                       else case split_part(o.rider_key, ':', 1) when 'companion' then 'comp' else split_part(o.rider_key, ':', 1) end
                            || ':' || o.request_id || ':' || split_part(o.rider_key, ':', 2) end,
         o.leg, o.place
  from public._off_route_riders(p_ride_id, '[]'::jsonb) o
  where public._ride_route_visible(p_ride_id);
$$;
revoke all on function public.ride_off_route_marks(uuid) from public;
grant execute on function public.ride_off_route_marks(uuid) to authenticated;

-- Tell the rider: once per (ride, rider, place), never the person who made the change.
create or replace function public._notify_off_route_riders(p_ride_id uuid) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_ride public.rides%rowtype; v_me uuid := (select auth.uid()); o record; v_to uuid; v_dest text;
begin
  select * into v_ride from public.rides where id = p_ride_id;
  if v_ride.id is null or v_ride.status = 'cancelled' then return; end if;
  if not exists (select 1 from public.ride_passengers rp where rp.ride_id = p_ride_id
                   and coalesce(rp.board_place_id::text, rp.board_place_text, rp.alight_place_id::text, rp.alight_place_text,
                                rp.return_board_place_id::text, rp.return_board_place_text, rp.return_alight_place_id::text, rp.return_alight_place_text) is not null)
     and not exists (select 1 from public.request_rider_stops s join public.ride_requests rr on rr.request_id = s.request_id
                     where rr.ride_id = p_ride_id and s.rides
                       and coalesce(s.board_place_id::text, s.board_place_text, s.alight_place_id::text, s.alight_place_text) is not null) then
    return;
  end if;
  select coalesce(d.name, '') into v_dest from public._ride_route(p_ride_id) x left join public.destinations d on d.id = x.place_id
   where x.leg = 'out' and x.kind = 'destination' limit 1;
  for o in select * from public._off_route_riders(p_ride_id, '[]'::jsonb) loop
    foreach v_to in array (select array_agg(distinct u) from unnest(o.recipients) u) loop
      continue when v_to is null or v_to is not distinct from v_me;
      perform public.enqueue_notification(v_to, 'outcome_changed', v_ride.department_id, v_ride.week_start,
        jsonb_build_object('day', public.day_date_label(v_ride.starts_at), 'place', coalesce(o.place, ''),
                           'destination', coalesce(v_dest, ''), 'names', coalesce(o.name, '')),
        jsonb_build_object('variant', 'rider_place_off_route', 'ride_id', p_ride_id),
        format('rider_off_route:%s:%s:%s:%s', p_ride_id, o.rider_key, o.leg, lower(coalesce(o.place, ''))));
    end loop;
  end loop;
end $$;
revoke all on function public._notify_off_route_riders(uuid) from public;

-- Deferred to the end of the transaction, so a change made of several writes is judged once, as it ends.
create or replace function public._tg_rider_off_route() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_ride uuid; v_req uuid;
begin
  if tg_table_name = 'rides' then
    perform public._notify_off_route_riders(new.id);
  elsif tg_table_name = 'ride_requests' then
    perform public._notify_off_route_riders(coalesce(new.ride_id, old.ride_id));
  else
    v_req := case when tg_op = 'DELETE' then old.request_id else new.request_id end;
    for v_ride in select distinct rr.ride_id from public.ride_requests rr where rr.request_id = v_req loop
      perform public._notify_off_route_riders(v_ride);
    end loop;
  end if;
  return null;
end $$;
revoke all on function public._tg_rider_off_route() from public;

create constraint trigger rider_off_route_stops after insert or update or delete on public.request_stops
  deferrable initially deferred for each row execute function public._tg_rider_off_route();
create constraint trigger rider_off_route_links after insert or update or delete on public.ride_requests
  deferrable initially deferred for each row execute function public._tg_rider_off_route();
create constraint trigger rider_off_route_rides after update of origin_id, destination_id, starts_at, ends_at on public.rides
  deferrable initially deferred for each row execute function public._tg_rider_off_route();

-- An unpublished day's rider notice waits for the publish, like the other ride-level outcome notices.
CREATE OR REPLACE FUNCTION "public"."_notice_is_unpublished_outcome"("_event" "public"."notification_event", "_data" "jsonb", "_recipient" "uuid", "_department_id" "uuid", "_week_start" "date", "_caller_days" "text") RETURNS boolean
    LANGUAGE "plpgsql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
declare
  v_variant text := nullif(_data ->> 'variant', '');
  v_ride_id uuid := nullif(_data ->> 'ride_id', '')::uuid;
  v_request_id uuid := nullif(_data ->> 'request_id', '')::uuid;
  v_at timestamptz;
begin
  if _event <> 'outcome_changed' or _department_id is null or _week_start is null then return false; end if;
  if v_variant is null then
    -- the publish-time diff carries its own `days`; any other null-variant outcome is a ride-level notice
    if _caller_days is not null or v_ride_id is null then return false; end if;
  elsif v_variant not in (
    'merged', 'merged_no_driver', 'merged_split', 'joined_ride', 'placed_by_sadran', 'driver_assigned',
    'driver_assigned_passenger', 'driver_cancelled', 'driver_cancelled_plain', 'driver_changed_passenger',
    'driver_replaced_you', 'driver_unassigned', 'car_changed', 'time_changed', 'edit_applied', 'edit_waitlisted',
    'alternative_applied', 'own_car_placed', 'passenger_added_you', 'passenger_joined', 'passenger_left', 'passenger_left_many',
    'passenger_removed_request', 'passenger_removed_you', 'companion_split', 'passengers_added', 'passengers_removed',
    'reservation_added', 'ride_cancelled', 'unassigned_by_sadran', 'child_removed', 'join_ride_cancelled', 'join_asked',
    'rider_place_off_route'
  ) then
    return false;
  end if;
  if _recipient is not null and exists (select 1 from public.sadranim_of(_department_id, _week_start) s where s = _recipient) then
    return false;
  end if;
  -- R14B5: a member who accepted an offer in the app is told what it did, published day or not: the answer was
  -- theirs, so the result is not planning news to hide. (The accepted party row is set before the proposal is applied.)
  if v_request_id is not null and _recipient is not null and exists (
       select 1 from public.proposals p join public.proposal_parties pp on pp.proposal_id = p.id
       where p.request_id = v_request_id and p.status = 'applied' and p.applied_at = now()
         and pp.profile_id = _recipient and pp.response = 'accepted' and pp.responded_via in ('token', 'session')) then
    return false;
  end if;
  if v_ride_id is not null then select r.starts_at into v_at from public.rides r where r.id = v_ride_id; end if;
  if v_at is null and v_request_id is not null then
    select coalesce(q.depart_at, q.return_at) into v_at from public.requests q where q.id = v_request_id;
  end if;
  if v_at is null then return false; end if;
  return not public.is_day_public(_department_id, _week_start, (v_at at time zone 'Asia/Jerusalem')::date);
end $$;

-- Copy (owner-approved 2026-11-24, "shorter"): the people-list mark is "⚠ <place> לא במסלול".
insert into public.notification_templates (event, channel, variant, title, body, default_title, default_body)
select 'outcome_changed'::public.notification_event, ch::public.notification_channel, 'rider_place_off_route', t.title, t.body, t.title, t.body
from (values ('{{place}} לא במסלול', 'יום {{day}} · {{place}} כבר לא במסלול של הנסיעה ל{{destination}}.')) as t(title, body)
cross join (values ('inbox'), ('push')) as c(ch)
on conflict (event, channel, coalesce(variant, '')) do nothing;
