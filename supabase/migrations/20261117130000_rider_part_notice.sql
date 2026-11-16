-- REQ item 246 h (owner 2026-11-17): "a change to my ride should notify me - it is the app's way to verify that both
-- sides know of the change." set_ride_person_part tells the ride's driver, the person (a child's guardians), the
-- request's owner / whoever added them - never the one who made the change - one `outcome_changed` notice each,
-- variant `rider_part_changed` (held like every board notice when made on the board).

insert into public.notification_templates (event, channel, variant, title, body, default_title, default_body)
select 'outcome_changed'::public.notification_event, ch, 'rider_part_changed', t.title, t.body, t.title, t.body
from (values ('{{byName}} שינה/תה איפה {{names}} עולה ויורד/ת', 'בנסיעה {{route}} ביום {{day}}. הפרטים בנסיעה.')) as t(title, body)
cross join unnest(array['inbox', 'push']::public.notification_channel[]) as ch
on conflict (event, channel, coalesce(variant, '')) do nothing;

create or replace function public.set_ride_person_part(p_ride_id uuid, p_expected_version integer, p_key text, p_parts jsonb) returns void
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
declare
  v_ride public.rides%rowtype;
  v_actor uuid := (select auth.uid());
  v_prefix text := split_part(coalesce(p_key, ''), ':', 1);
  v_has_out boolean; v_has_ret boolean;
  v_out jsonb; v_ret jsonb; v_rides_out boolean; v_rides_ret boolean;
  v_row public.ride_passengers%rowtype;
  v_request_id uuid; v_rider_key text; v_seat text; v_cov_out boolean; v_cov_ret boolean;
  l public.ride_leg; v_part jsonb;
  v_names text; v_new_version int; v_actor_name text; v_route text; v_recipient uuid; v_recipients uuid[] := '{}';
begin
  select * into v_ride from public.rides where id = p_ride_id for update;
  if not found or v_ride.status = 'cancelled' then raise exception 'ride_not_found' using errcode = 'P0001'; end if;
  if not public.member_of(v_ride.department_id) then raise exception 'not_authorized' using errcode = 'P0001'; end if;
  if not public.ride_related(p_ride_id, v_actor) then
    perform public.assert_private_car_owner_only(v_ride.car_id, v_actor, null);
  end if;
  if not (public.is_week_public(v_ride.department_id, v_ride.week_start) or public.can_manage_week(v_ride.department_id, v_ride.week_start)) then
    raise exception 'ride_week_not_public' using errcode = 'P0001';
  end if;
  if p_expected_version is null or v_ride.version <> p_expected_version then perform public.raise_stale_version(); end if;
  if exists (select 1 from public.weeks where department_id = v_ride.department_id and week_start = v_ride.week_start and phase = 'archived') then
    raise exception 'week_archived' using errcode = 'P0001';
  end if;
  if jsonb_typeof(coalesce(p_parts, '{}'::jsonb)) <> 'object' then raise exception 'invalid_ride_passenger' using errcode = 'P0001'; end if;

  v_out := p_parts -> 'out'; v_ret := p_parts -> 'return';
  v_rides_out := not (p_parts ? 'out') or jsonb_typeof(v_out) = 'object';
  v_rides_ret := not (p_parts ? 'return') or jsonb_typeof(v_ret) = 'object';
  if (p_parts ? 'out' and jsonb_typeof(v_out) not in ('object', 'null')) or (p_parts ? 'return' and jsonb_typeof(v_ret) not in ('object', 'null')) then
    raise exception 'invalid_ride_passenger' using errcode = 'P0001';
  end if;
  v_out := coalesce(nullif(v_out, 'null'::jsonb), '{}'::jsonb); v_ret := coalesce(nullif(v_ret, 'null'::jsonb), '{}'::jsonb);
  foreach v_part in array array[v_out, v_ret] loop
    if not public._rider_place_ok(v_ride.department_id, nullif(v_part ->> 'board_place_id', '')::uuid, nullif(trim(v_part ->> 'board_place_text'), ''))
       or not public._rider_place_ok(v_ride.department_id, nullif(v_part ->> 'alight_place_id', '')::uuid, nullif(trim(v_part ->> 'alight_place_text'), '')) then
      raise exception 'invalid_ride_passenger' using errcode = 'P0001';
    end if;
  end loop;

  -- the directions the ride carries (a ride serving nobody: the way there)
  select coalesce(bool_or(rr.covers_out), true), coalesce(bool_or(rr.covers_return), false) into v_has_out, v_has_ret
    from public.ride_requests rr where rr.ride_id = p_ride_id;
  perform set_config('app.audit_reason', 'set_ride_person_part', true);

  if v_prefix = 'added' then
    select * into v_row from public.ride_passengers where id = nullif(split_part(p_key, ':', 2), '')::uuid and ride_id = p_ride_id;
    if not found then raise exception 'ride_not_found' using errcode = 'P0001'; end if;
    v_names := v_row.display_name;
    v_recipients := array_remove(array[v_row.person_id, v_row.added_by], null)
      || coalesce((select array_agg(cg.profile_id) from public.child_guardians cg where cg.child_id = v_row.child_id), '{}');
    if not ((v_has_out and v_rides_out) or (v_has_ret and v_rides_ret)) then raise exception 'invalid_ride_passenger' using errcode = 'P0001'; end if;
    -- one row: the directions it rides, the way there's places, and for both ways the way back's
    update public.ride_passengers rp set
      leg = case when v_has_out and v_has_ret then
                   case when v_rides_out and v_rides_ret then 'both' when v_rides_out then 'out' else 'return' end::public.ride_leg
                 else v_row.leg end,
      board_place_id = nullif(x.p ->> 'board_place_id', '')::uuid, board_place_text = nullif(trim(x.p ->> 'board_place_text'), ''),
      alight_place_id = nullif(x.p ->> 'alight_place_id', '')::uuid, alight_place_text = nullif(trim(x.p ->> 'alight_place_text'), ''),
      return_board_place_id = case when x.both then nullif(v_ret ->> 'board_place_id', '')::uuid end,
      return_board_place_text = case when x.both then nullif(trim(v_ret ->> 'board_place_text'), '') end,
      return_alight_place_id = case when x.both then nullif(v_ret ->> 'alight_place_id', '')::uuid end,
      return_alight_place_text = case when x.both then nullif(trim(v_ret ->> 'alight_place_text'), '') end
      from (select (v_has_out and v_rides_out and v_has_ret and v_rides_ret) as both,
                   -- the row's own direction's places: the way there's unless it rides only back
                   case when (v_has_out and v_rides_out) or not v_has_ret then v_out else v_ret end as p) x
     where rp.id = v_row.id;

  elsif v_prefix in ('comp', 'child', 'guest') then
    v_request_id := nullif(split_part(p_key, ':', 2), '')::uuid;
    select coalesce(bool_or(rr.covers_out), false), coalesce(bool_or(rr.covers_return), false) into v_cov_out, v_cov_ret
      from public.ride_requests rr where rr.ride_id = p_ride_id and rr.request_id = v_request_id;
    if v_request_id is null or not (v_cov_out or v_cov_ret) then raise exception 'ride_not_found' using errcode = 'P0001'; end if;
    v_rider_key := case v_prefix when 'comp' then 'companion' else v_prefix end || ':' || split_part(p_key, ':', 3);
    if v_prefix = 'comp' and not exists (select 1 from public.request_companions rc where rc.request_id = v_request_id
                                          and rc.profile_id = nullif(split_part(p_key, ':', 3), '')::uuid)
       or v_prefix = 'child' and not exists (select 1 from public.request_children rc where rc.request_id = v_request_id
                                              and rc.child_id = nullif(split_part(p_key, ':', 3), '')::uuid)
       or v_prefix = 'guest' and not exists (select 1 from public.requests q where q.id = v_request_id
                                              and nullif(split_part(p_key, ':', 3), '')::int between 1 and least(coalesce(cardinality(q.guest_passenger_names), 0), 20)) then
      raise exception 'ride_not_found' using errcode = 'P0001';
    end if;
    if not ((v_cov_out and v_rides_out) or (v_cov_ret and v_rides_ret)) then raise exception 'invalid_ride_passenger' using errcode = 'P0001'; end if;
    v_names := case v_prefix
      when 'comp' then (select p.full_name from public.profiles p where p.id = nullif(split_part(p_key, ':', 3), '')::uuid)
      when 'child' then (select c.full_name from public.children c where c.id = nullif(split_part(p_key, ':', 3), '')::uuid)
      else (select q.guest_passenger_names[nullif(split_part(p_key, ':', 3), '')::int] from public.requests q where q.id = v_request_id) end;
    v_recipients := array_remove(array[(select q.requester_id from public.requests q where q.id = v_request_id),
                                       case when v_prefix = 'comp' then nullif(split_part(p_key, ':', 3), '')::uuid end], null)
      || case when v_prefix = 'child' then coalesce((select array_agg(cg.profile_id) from public.child_guardians cg
                                                     where cg.child_id = nullif(split_part(p_key, ':', 3), '')::uuid), '{}') else '{}' end;
    v_seat := case when v_prefix = 'child' then coalesce((select s.seat_kind from public.request_rider_stops s
                     where s.request_id = v_request_id and s.rider_key = v_rider_key order by s.leg limit 1), 'child_seat') else 'adult' end;
    -- the directions this ride carries for the request; the other one (another ride) keeps its row
    delete from public.request_rider_stops s where s.request_id = v_request_id and s.rider_key = v_rider_key
       and ((s.leg = 'out' and v_cov_out) or (s.leg = 'return' and v_cov_ret));
    foreach l in array array['out', 'return']::public.ride_leg[] loop
      continue when (l = 'out' and not v_cov_out) or (l = 'return' and not v_cov_ret);
      v_part := case when l = 'out' then v_out else v_ret end;
      if not (case when l = 'out' then v_rides_out else v_rides_ret end) then
        insert into public.request_rider_stops (request_id, department_id, rider_key, seat_kind, leg, rides)
        values (v_request_id, v_ride.department_id, v_rider_key, v_seat, l, false);
      elsif coalesce(v_part ->> 'board_place_id', nullif(trim(v_part ->> 'board_place_text'), ''),
                     v_part ->> 'alight_place_id', nullif(trim(v_part ->> 'alight_place_text'), '')) is not null then
        insert into public.request_rider_stops (request_id, department_id, rider_key, seat_kind, leg, rides,
                                                board_place_id, board_place_text, alight_place_id, alight_place_text)
        values (v_request_id, v_ride.department_id, v_rider_key, v_seat, l, true,
                nullif(v_part ->> 'board_place_id', '')::uuid, nullif(trim(v_part ->> 'board_place_text'), ''),
                nullif(v_part ->> 'alight_place_id', '')::uuid, nullif(trim(v_part ->> 'alight_place_text'), ''));
      end if;
    end loop;
    update public.requests set updated_at = now() where id = v_request_id;

  else
    raise exception 'ride_person_not_editable' using errcode = 'P0001';
  end if;

  -- more of the way for someone may not fit: the one-number check first, then per direction and stretch
  if not public._ride_people_fit(p_ride_id) then
    raise exception 'ride_seats_exceeded' using errcode = 'P0001';
  end if;

  update public.rides set updated_at = now() where id = p_ride_id returning version into v_new_version;

  -- REQ item 246 h (owner 2026-11-17): a change to my ride tells me - the driver, the person (a child's guardians), the
  -- request's owner / whoever added them; never the one who made it. One notice each.
  v_recipients := array_append(v_recipients, v_ride.driver_id);
  select full_name into v_actor_name from public.profiles where id = v_actor;
  v_route := public.ride_notice_route(p_ride_id);
  for v_recipient in select distinct x from unnest(v_recipients) x where x is not null and x is distinct from v_actor order by 1 loop
    perform public.enqueue_notification(v_recipient, 'outcome_changed', v_ride.department_id, v_ride.week_start,
      jsonb_build_object('byName', coalesce(v_actor_name, ''), 'names', coalesce(v_names, ''), 'route', coalesce(v_route, '')),
      jsonb_build_object('variant', 'rider_part_changed', 'ride_id', p_ride_id),
      format('rider_part_changed:%s:%s:%s', p_ride_id, v_new_version, v_recipient));
  end loop;
end;
$$;
