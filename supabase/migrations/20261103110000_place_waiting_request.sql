-- REQ §13.183 (owner 2026-11-03): a member drags a waiting round trip from the siddur's "חסר רכב" column onto a car,
-- at the hours they drop it. `place_waiting_request()` checks that car at those hours: refusals (someone else's ride,
-- maintenance, seats, someone else's private car, a car held by an open "בדיון" group or offered after a cancellation,
-- the car's next ride starting elsewhere, no driver) change nothing; warnings that only concern the member (the car
-- stands elsewhere, a turnaround shorter than the buffer, no large trunk) come back unless the caller accepts them
-- (`p_accept`). With nothing left to object to, the request takes the new hours (and the car's place as its start, when
-- that warning was accepted) and goes on the car, confirmed (a published day), the Sadranim told as for any edit.
-- Who: whoever may edit the request (`can_edit_request`: requester, filer, related people, the department's
-- "anyone edits rides" switch, the week's Sadran) — and a private car's owner, onto that car only ("give my car",
-- REQ §13.129 a for waiting rides): the requester then drives the owner's car and is told so (`owner_car_given`).
create or replace function public.place_waiting_request(
  p_request_id uuid, p_car_id uuid, p_depart_at timestamptz, p_return_at timestamptz,
  p_expected_version int, p_accept text[] default '{}'
) returns jsonb
language plpgsql security definer
set search_path = public, pg_temp
as $$
declare
  q public.requests%rowtype; v_car public.cars%rowtype; v_uid uuid := (select auth.uid());
  v_home uuid; v_origin uuid; v_car_at uuid; v_start uuid; v_next uuid; v_buffer int;
  v_prev_end timestamptz; v_next_start timestamptz; v_day date; v_phase public.week_phase;
  v_warnings jsonb := '[]'::jsonb; v_ride uuid; v_prev_transition text; v_prev_trunk text;
  v_accept text[] := coalesce(p_accept, '{}'); v_moved boolean := false;
begin
  select * into q from public.requests where id = p_request_id for update;
  select * into v_car from public.cars where id = p_car_id and department_id = q.department_id and status = 'active';
  if q.id is null or not (public.can_edit_request(q.id)
       or (v_car.type = 'temporary' and v_car.owner_id = v_uid and public.member_of(q.department_id))) then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  if q.version <> p_expected_version then raise exception 'stale_version' using errcode = 'P0409'; end if;
  if q.status <> 'waitlisted' or q.trip_type <> 'round_trip' or q.series_id is not null then
    return jsonb_build_object('ok', false, 'blocked', 'not_draggable');
  end if;
  if p_depart_at is null or p_return_at is null or p_return_at <= p_depart_at
     or (p_depart_at at time zone 'Asia/Jerusalem')::date <> (p_return_at at time zone 'Asia/Jerusalem')::date then
    raise exception 'invalid_ride_window' using errcode = 'P0001';
  end if;
  v_day := (p_depart_at at time zone 'Asia/Jerusalem')::date;
  select phase into v_phase from public.weeks where department_id = q.department_id and week_start = q.week_start;
  if v_phase not in ('published', 'live') or not public.is_day_public(q.department_id, q.week_start, v_day)
     or v_day <> ((coalesce(q.depart_at, q.return_at)) at time zone 'Asia/Jerusalem')::date then
    return jsonb_build_object('ok', false, 'blocked', 'not_draggable');
  end if;
  if p_depart_at < now() then return jsonb_build_object('ok', false, 'blocked', 'past'); end if;
  if exists (select 1 from public.ride_requests rr join public.rides r on r.id = rr.ride_id
             where rr.request_id = q.id and r.status <> 'cancelled')
     or exists (select 1 from public.waitlist_group_members gm join public.waitlist_groups g on g.id = gm.group_id
                where gm.request_id = q.id and g.status = 'open') then
    return jsonb_build_object('ok', false, 'blocked', 'not_draggable');
  end if;

  if v_car.id is null then raise exception 'shift_car_invalid' using errcode = 'P0001'; end if;
  perform pg_advisory_xact_lock(hashtextextended(v_car.id::text, 0));

  -- Refusals: nothing a member may take from someone else.
  -- Only the owner puts a request on their private car (REQ §13.99).
  if v_car.type = 'temporary' and v_car.owner_id is distinct from v_uid then
    return jsonb_build_object('ok', false, 'blocked', 'private_car');
  end if;
  if exists (select 1 from public.rides r where r.car_id = v_car.id and r.status <> 'cancelled' and not r.draft_hold
             and tstzrange(r.starts_at, r.ends_at, '[)') && tstzrange(p_depart_at, p_return_at, '[)')) then
    return jsonb_build_object('ok', false, 'blocked', 'overlap');
  end if;
  if exists (select 1 from public.car_maintenance_blocks m where m.car_id = v_car.id
             and tstzrange(m.starts_at, m.ends_at, '[)') && tstzrange(p_depart_at, p_return_at, '[)')) then
    return jsonb_build_object('ok', false, 'blocked', 'maintenance');
  end if;
  if not public.car_fits(v_car.id, q.adults, q.child_seats, q.boosters) then
    return jsonb_build_object('ok', false, 'blocked', 'seats');
  end if;
  if public.car_held_by_waitlist_group(v_car.id, p_depart_at, p_return_at, q.id) then
    return jsonb_build_object('ok', false, 'blocked', 'held');
  end if;
  if exists (select 1 from public.freed_slot_offers o where o.car_id = v_car.id and o.status = 'open'
             and o.expires_at > now() and tstzrange(o.starts_at, o.ends_at, '[)') && tstzrange(p_depart_at, p_return_at, '[)')) then
    return jsonb_build_object('ok', false, 'blocked', 'offered');
  end if;
  if public.eligible_leg_driver(q.id) is null then
    return jsonb_build_object('ok', false, 'blocked', 'no_driver');
  end if;

  -- Where the ride starts: the request's place, or — once the member accepts it — where the car stands.
  select home_destination_id into v_home from public.departments where id = q.department_id;
  v_origin := case when q.origin_id is null and nullif(q.origin_text, '') is not null then null else coalesce(q.origin_id, v_home) end;
  v_car_at := coalesce(public.car_location_at(v_car.id, p_depart_at), v_home);
  v_start := coalesce(v_origin, v_home);
  -- A shared car is taken where it stands (a free-text start place never matches it); a private car goes with its owner.
  if v_car.type = 'shared' and (v_origin is null or v_car_at <> v_origin) then
    if 'location' = any(v_accept) then v_start := v_car_at; v_moved := true;
    else v_warnings := v_warnings || jsonb_build_object('code', 'location',
           'place', (select name from public.destinations where id = v_car_at));
    end if;
  end if;
  v_next := public.car_next_ride_origin(v_car.id, p_return_at);
  if v_next is not null and v_next <> v_start then
    return jsonb_build_object('ok', false, 'blocked', 'next_elsewhere');
  end if;

  -- Warnings that concern the member only.
  v_buffer := coalesce(public.required_turnaround_minutes(q.department_id, q.week_start), 30);
  select max(r.ends_at) into v_prev_end from public.rides r
    where r.car_id = v_car.id and r.status <> 'cancelled' and not r.draft_hold and r.ends_at <= p_depart_at;
  select min(r.starts_at) into v_next_start from public.rides r
    where r.car_id = v_car.id and r.status <> 'cancelled' and not r.draft_hold and r.starts_at >= p_return_at;
  if (v_prev_end is not null and v_prev_end + make_interval(mins => v_buffer) > p_depart_at)
     or (v_next_start is not null and p_return_at + make_interval(mins => v_buffer) > v_next_start) then
    if not 'turnaround' = any(v_accept) then
      v_warnings := v_warnings || jsonb_build_object('code', 'turnaround', 'minutes', v_buffer);
    end if;
  end if;
  if q.has_luggage and q.luggage_waived_at is null and not public.car_takes_luggage(v_car.id, 1)
     and not 'luggage' = any(v_accept) then
    v_warnings := v_warnings || jsonb_build_object('code', 'luggage');
  end if;
  if jsonb_array_length(v_warnings) > 0 then
    return jsonb_build_object('ok', false, 'warnings', v_warnings);
  end if;

  -- Place it: the new hours and start place, then the same placement the Sadran's manual drop uses.
  v_prev_transition := current_setting('app.system_status_transition', true);
  v_prev_trunk := current_setting('app.small_trunk', true);
  perform set_config('app.system_status_transition', 'on', true);
  if 'luggage' = any(v_accept) then perform set_config('app.small_trunk', 'allow', true); end if;
  update public.requests set depart_at = p_depart_at, return_at = p_return_at, preferred_car_id = case when v_car.type = 'shared' then v_car.id else preferred_car_id end,
         origin_id = case when v_moved then v_start else origin_id end,
         origin_text = case when v_moved then null else origin_text end,
         changed_since_solve = true
   where id = q.id;
  v_ride := public.place_request_on_car(q.id, v_car.id, true, v_uid, null, p_depart_at, p_return_at, 'MEMBER_PLACED');
  perform set_config('app.small_trunk', coalesce(v_prev_trunk, ''), true);
  perform set_config('app.system_status_transition', coalesce(v_prev_transition, 'off'), true);

  perform public.enqueue_notification(s.profile_id, 'request_changed', q.department_id, q.week_start,
    jsonb_build_object('requestId', q.id::text), jsonb_build_object('request_id', q.id),
    format('request_changed:%s:%s', q.id, now()))
  from public.sadranim_of(q.department_id, q.week_start) as s(profile_id)
  where s.profile_id is distinct from v_uid;

  -- The owner gave their car: the requester (and a filer) learn they drive it.
  perform public.enqueue_notification(x.recipient, 'outcome_changed', q.department_id, q.week_start,
    jsonb_build_object('byName', coalesce((select full_name from public.profiles where id = v_uid), ''),
      'route', coalesce(public.request_route_label(q.id), ''), 'day', public.day_date_label(p_depart_at),
      'timeRange', public._window_text(p_depart_at, p_return_at), 'car', v_car.name),
    jsonb_build_object('variant', 'owner_car_given', 'request_id', q.id, 'ride_id', v_ride),
    format('owner_car_given:%s:%s', q.id, x.recipient))
  from (select distinct r as recipient from unnest(array[q.requester_id, q.filed_by]) r) x
  where v_car.type = 'temporary' and x.recipient is not null and x.recipient <> v_uid;

  return jsonb_build_object('ok', true, 'ride_id', v_ride, 'car_id', v_car.id);
end $$;

revoke all on function public.place_waiting_request(uuid, uuid, timestamptz, timestamptz, int, text[]) from public;
grant execute on function public.place_waiting_request(uuid, uuid, timestamptz, timestamptz, int, text[]) to authenticated;

-- The notice to the requester when a private car's owner gives them the car (REQ §13.183).
insert into public.notification_templates (event, channel, variant, title, body, default_title, default_body)
select 'outcome_changed', ch, 'owner_car_given', t.title, t.body, t.title, t.body
from (values ('{{byName}} נתן/ה לך את הרכב שלו/ה', '{{route}} · {{day}} {{timeRange}} · {{car}} — את/ה נוהג/ת')) as t(title, body)
cross join unnest(array['inbox', 'push']::public.notification_channel[]) as ch
on conflict (event, channel, coalesce(variant, '')) do update
  set title = excluded.title, body = excluded.body, default_title = excluded.default_title, default_body = excluded.default_body;
