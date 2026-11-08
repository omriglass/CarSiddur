-- REQ §13.203: a member asks another member to make room only after talking to them, and what is asked is the
-- smallest change per ride in the way: return earlier ('end'), leave later ('start') or give the ride up ('cancel').
-- Works for moving one's own ride (siddur / my rides) and for a new waiting-list round trip.

-- What each ride on p_car_id in the way of [p_starts_at, p_ends_at) would have to give up (turnaround included,
-- 15-minute grid). `askable`: a ride its driver drives alone for their own request(s), round trip from and back to the
-- same place, not the requester's — anything else is for the Sadran.
create or replace function public._ride_shorten_plan(p_department_id uuid, p_week_start date, p_car_id uuid,
  p_starts_at timestamptz, p_ends_at timestamptz, p_exclude_ride uuid, p_requester uuid)
returns table(ride_id uuid, driver_id uuid, driver_name text, ride_version integer, starts_at timestamptz,
  ends_at timestamptz, end_option timestamptz, start_option timestamptz, askable boolean)
language sql stable security definer set search_path = public, pg_temp as $$
  with b as (
    select make_interval(mins => coalesce(public.required_turnaround_minutes(p_department_id, p_week_start), 30)) as buf
  )
  select r.id, r.driver_id, p.full_name, r.version, r.starts_at, r.ends_at,
    case when e.at > r.starts_at then e.at end,
    case when s.at < r.ends_at then s.at end,
    (r.driver_id is not null and r.driver_id is distinct from p_requester
      and r.origin_id = r.destination_id and not r.auto_relocation and not r.planning_conflict
      and exists (select 1 from public.ride_requests rr where rr.ride_id = r.id)
      and not exists (select 1 from public.ride_requests rr join public.requests q on q.id = rr.request_id
        where rr.ride_id = r.id and (q.requester_id <> r.driver_id or rr.car_mode = 'relay'))
      and not exists (select 1 from public.ride_requests rr join public.request_companions c on c.request_id = rr.request_id
        where rr.ride_id = r.id)
      and not exists (select 1 from public.ride_passengers rp
        where rp.ride_id = r.id and rp.child_id is null and rp.person_id is distinct from r.driver_id))
  from public.rides r
  cross join b
  left join public.profiles p on p.id = r.driver_id
  cross join lateral (select to_timestamp(floor(extract(epoch from p_starts_at - b.buf) / 900) * 900) as at) e
  cross join lateral (select to_timestamp(ceil(extract(epoch from p_ends_at + b.buf) / 900) * 900) as at) s
  where r.car_id = p_car_id and r.id is distinct from p_exclude_ride and r.status <> 'cancelled' and not r.draft_hold
    and tstzrange(r.starts_at, r.blocked_until, '[)') && tstzrange(p_starts_at, p_ends_at + b.buf, '[)')
  order by r.starts_at, r.id;
$$;
revoke all on function public._ride_shorten_plan(uuid, date, uuid, timestamptz, timestamptz, uuid, uuid) from public;

-- The plan as the browser shows it: one entry per ride in the way, with the driver's phone for the WhatsApp button.
create or replace function public._ride_shorten_parties_json(p_department_id uuid, p_week_start date, p_car_id uuid,
  p_starts_at timestamptz, p_ends_at timestamptz, p_exclude_ride uuid, p_requester uuid)
returns jsonb
language sql stable security definer set search_path = public, pg_temp as $$
  select coalesce(jsonb_agg(jsonb_build_object(
      'ride_id', x.ride_id, 'driver_id', x.driver_id, 'name', coalesce(x.driver_name, ''), 'phone', public.phone_of(x.driver_id),
      'starts_at', x.starts_at, 'ends_at', x.ends_at, 'end_option', x.end_option, 'start_option', x.start_option,
      'askable', x.askable) order by x.starts_at, x.ride_id), '[]'::jsonb)
  from public._ride_shorten_plan(p_department_id, p_week_start, p_car_id, p_starts_at, p_ends_at, p_exclude_ride, p_requester) x;
$$;
revoke all on function public._ride_shorten_parties_json(uuid, date, uuid, timestamptz, timestamptz, uuid, uuid) from public;

-- A car a waiting-list round trip could take once the rides in its way make room: the same rules as auto-approve
-- (_auto_approve_free_car) except the overlap with other rides.
create or replace function public._ride_shorten_car_fits(p_request_id uuid, p_car_id uuid)
returns boolean
language sql stable security definer set search_path = public, pg_temp as $$
  select exists (
    select 1
    from public.requests q
    join public.cars c on c.id = p_car_id and c.department_id = q.department_id
    join public.car_seat_configs csc on csc.car_id = c.id
    cross join lateral (select make_interval(mins => coalesce(public.required_turnaround_minutes(q.department_id, q.week_start), 30)) as buf) b
    where q.id = p_request_id and c.status = 'active' and c.type = 'shared'
      and csc.adults >= q.adults and csc.child_seats >= q.child_seats and csc.boosters >= q.boosters
      and (not (q.has_luggage and q.luggage_waived_at is null) or 'large_trunk' = any(c.features))
      and public.car_location_at(c.id, q.depart_at) = q.origin_id
      and coalesce(public.car_next_ride_origin(c.id, q.return_at), q.origin_id) = q.origin_id
      and not public._draft_hold_conflict(c.id, q.depart_at, q.return_at + b.buf, array[q.id])
      and not exists (select 1 from public.car_maintenance_blocks m
        where m.car_id = c.id and tstzrange(m.starts_at, m.ends_at, '[)') && tstzrange(q.depart_at, q.return_at + b.buf, '[)'))
      and not public.car_held_by_waitlist_group(c.id, q.depart_at, q.return_at + b.buf, q.id));
$$;
revoke all on function public._ride_shorten_car_fits(uuid, uuid) from public;

-- The member's own waiting-list round trip on a published day, still ahead (REQ §13.203 a).
create or replace function public._ride_shorten_request(p_request_id uuid)
returns public.requests
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare q public.requests%rowtype;
begin
  select * into q from public.requests where id = p_request_id;
  if q.id is null then raise exception 'request_not_found' using errcode = 'P0001'; end if;
  if not public.is_approved() or (select auth.uid()) not in (q.requester_id, coalesce(q.filed_by, q.requester_id)) then
    raise exception 'not_authorized' using errcode = 'P0001';
  end if;
  if q.status <> 'waitlisted' or q.trip_type <> 'round_trip' or q.origin_id is null or q.depart_at is null or q.return_at is null
     or q.depart_at <= now()
     or not public.is_day_public(q.department_id, q.week_start, (q.depart_at at time zone 'Asia/Jerusalem')::date) then
    raise exception 'request_not_editable' using errcode = 'P0001';
  end if;
  return q;
end $$;
revoke all on function public._ride_shorten_request(uuid) from public;

-- Moving my ride onto a taken slot: who is in the way and what each could give up.
create or replace function public.ride_shorten_options(p_ride_id uuid, p_car_id uuid, p_starts_at timestamptz, p_ends_at timestamptz)
returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare r public.rides%rowtype; v_parties jsonb; v_maintenance boolean;
begin
  select * into r from public.rides where id = p_ride_id;
  if not found then raise exception 'ride_not_found' using errcode = 'P0001'; end if;
  if not public.is_approved() or r.driver_id is distinct from (select auth.uid()) or not public.is_week_public(r.department_id, r.week_start) then
    raise exception 'not_authorized' using errcode = 'P0001';
  end if;
  if not exists (select 1 from public.cars where id = p_car_id and department_id = r.department_id) then
    raise exception 'car_unavailable' using errcode = 'P0001';
  end if;
  v_parties := public._ride_shorten_parties_json(r.department_id, r.week_start, p_car_id, p_starts_at, p_ends_at, r.id, r.driver_id);
  select exists (select 1 from public.car_maintenance_blocks m where m.car_id = p_car_id
    and tstzrange(m.starts_at, m.ends_at, '[)') && tstzrange(p_starts_at, p_ends_at
      + make_interval(mins => coalesce(public.required_turnaround_minutes(r.department_id, r.week_start), 30)), '[)')) into v_maintenance;
  return jsonb_build_object('parties', v_parties,
    'askable', jsonb_array_length(v_parties) > 0 and not v_maintenance
      and not exists (select 1 from jsonb_array_elements(v_parties) x where not (x ->> 'askable')::boolean));
end $$;
revoke all on function public.ride_shorten_options(uuid, uuid, timestamptz, timestamptz) from public;
grant execute on function public.ride_shorten_options(uuid, uuid, timestamptz, timestamptz) to authenticated;

-- A new waiting-list round trip: the cars that could take it if the rides in the way made room, least given up first.
create or replace function public.ride_shorten_options_for_request(p_request_id uuid)
returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare q public.requests%rowtype;
begin
  q := public._ride_shorten_request(p_request_id);
  return coalesce((
    select jsonb_agg(jsonb_build_object('car_id', x.car_id, 'car_name', x.car_name, 'parties', x.parties) order by x.cost, x.car_id)
    from (
      select c.id as car_id, c.name as car_name, pj.parties,
        (select sum(least(
            coalesce(extract(epoch from (y.ends_at - y.end_option)), 1e9),
            coalesce(extract(epoch from (y.start_option - y.starts_at)), 1e9),
            extract(epoch from (y.ends_at - y.starts_at))))
         from public._ride_shorten_plan(q.department_id, q.week_start, c.id, q.depart_at, q.return_at, null, q.requester_id) y) as cost
      from public.cars c
      cross join lateral (select public._ride_shorten_parties_json(q.department_id, q.week_start, c.id, q.depart_at, q.return_at, null, q.requester_id) as parties) pj
      where c.department_id = q.department_id and c.status = 'active' and c.type = 'shared'
        and public._ride_shorten_car_fits(q.id, c.id)
        and jsonb_array_length(pj.parties) > 0
        and not exists (select 1 from jsonb_array_elements(pj.parties) e where not (e ->> 'askable')::boolean)
      order by 4, 1
      limit 3) x), '[]'::jsonb);
end $$;
revoke all on function public.ride_shorten_options_for_request(uuid) from public;
grant execute on function public.ride_shorten_options_for_request(uuid) to authenticated;

-- Send the request. Exactly one of p_ride_id (move my ride to p_car_id at p_starts_at–p_ends_at) or p_request_id (place my
-- waiting-list round trip on p_car_id at its own hours). p_cuts = [{ride_id, cut: 'end'|'start'|'cancel'}], one per ride
-- in the way, as agreed; p_talked must be true (REQ §13.203 a).
create or replace function public.request_ride_shorten(p_ride_id uuid, p_request_id uuid, p_car_id uuid,
  p_starts_at timestamptz, p_ends_at timestamptz, p_expected_version integer, p_cuts jsonb, p_talked boolean,
  p_allow_small_trunk boolean default false)
returns uuid
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  r public.rides%rowtype; q public.requests%rowtype; v_uid uuid := (select auth.uid());
  v_dept uuid; v_week date; v_version integer; v_s timestamptz; v_e timestamptz;
  x record; v_cut text; v_ns timestamptz; v_ne timestamptz; ch uuid; cnt int := 0; buffer interval; v_name text;
begin
  if not coalesce(p_talked, false) then raise exception 'ride_shorten_needs_talk' using errcode = 'P0001'; end if;
  if (p_ride_id is null) = (p_request_id is null) then raise exception 'ride_shorten_invalid' using errcode = 'P0001'; end if;

  if p_ride_id is not null then
    -- Same checks as moving one's own ride (request_ride_change before REQ §13.203).
    select * into r from public.rides where id = p_ride_id for update;
    if not found then raise exception 'ride_not_found' using errcode = 'P0001'; end if;
    if not public.is_approved() or r.driver_id is distinct from v_uid or not public.is_week_public(r.department_id, r.week_start) then
      raise exception 'not_authorized' using errcode = 'P0001';
    end if;
    if r.status = 'cancelled' or r.version <> p_expected_version then perform public.raise_stale_version(); end if;
    if (r.starts_at at time zone 'Asia/Jerusalem')::date < (now() at time zone 'Asia/Jerusalem')::date or p_ends_at <= p_starts_at
       or (p_starts_at at time zone 'Asia/Jerusalem')::date <> (r.starts_at at time zone 'Asia/Jerusalem')::date then
      raise exception 'ride_request_day_mismatch' using errcode = 'P0001';
    end if;
    if not (public.week_range(r.week_start) @> tstzrange(p_starts_at, p_ends_at, '[)')) then raise exception 'ride_outside_week' using errcode = 'P0001'; end if;
    if exists (select 1 from public.ride_requests rr join public.requests rq on rq.id = rr.request_id
               where rr.ride_id = r.id and (rq.requester_id <> r.driver_id or rr.car_mode = 'relay')) then
      raise exception 'shared_ride_requires_sadran' using errcode = 'P0001';
    end if;
    perform public._small_trunk_check(array(select rr.request_id from public.ride_requests rr where rr.ride_id = r.id), p_car_id, p_allow_small_trunk);
    perform 1 from public.cars where id = p_car_id and department_id = r.department_id and status = 'active' and type = 'shared' for update;
    if not found then raise exception 'car_unavailable' using errcode = 'P0001'; end if;
    v_dept := r.department_id; v_week := r.week_start; v_version := r.version; v_s := p_starts_at; v_e := p_ends_at;
  else
    q := public._ride_shorten_request(p_request_id);
    perform 1 from public.requests where id = q.id for update;
    if not public._ride_shorten_car_fits(q.id, p_car_id) then raise exception 'car_unavailable' using errcode = 'P0001'; end if;
    v_dept := q.department_id; v_week := q.week_start; v_version := q.version; v_s := q.depart_at; v_e := q.return_at;
  end if;

  buffer := make_interval(mins => coalesce(public.required_turnaround_minutes(v_dept, v_week), 30));
  if exists (select 1 from public.car_maintenance_blocks where car_id = p_car_id
             and tstzrange(starts_at, ends_at, '[)') && tstzrange(v_s, v_e + buffer, '[)')) then
    raise exception 'ride_conflicts_with_maintenance' using errcode = 'P0001';
  end if;

  update public.ride_change_requests set status = 'cancelled'
  where status = 'pending' and ((p_ride_id is not null and ride_id = p_ride_id) or (p_request_id is not null and request_id = p_request_id));
  insert into public.ride_change_requests(department_id, week_start, requester_id, ride_id, request_id, car_id, starts_at, ends_at,
    expected_version, allow_small_trunk, talked)
  values (v_dept, v_week, v_uid, p_ride_id, p_request_id, p_car_id, v_s, v_e, v_version, coalesce(p_allow_small_trunk, false), true)
  returning id into ch;
  select full_name into v_name from public.profiles where id = v_uid;

  for x in select * from public._ride_shorten_plan(v_dept, v_week, p_car_id, v_s, v_e, p_ride_id, coalesce(r.driver_id, q.requester_id)) loop
    if not x.askable then raise exception 'shared_ride_requires_sadran' using errcode = 'P0001'; end if;
    perform 1 from public.rides where id = x.ride_id for update;
    select c ->> 'cut' into v_cut from jsonb_array_elements(coalesce(p_cuts, '[]'::jsonb)) c where c ->> 'ride_id' = x.ride_id::text limit 1;
    v_ns := null; v_ne := null;
    if v_cut = 'end' and x.end_option is not null then v_ne := x.end_option;
    elsif v_cut = 'start' and x.start_option is not null then v_ns := x.start_option;
    elsif v_cut is distinct from 'cancel' then raise exception 'ride_shorten_invalid' using errcode = 'P0001';
    end if;
    insert into public.ride_change_parties(change_id, ride_id, profile_id, expected_version, cut, new_starts_at, new_ends_at)
    values (ch, x.ride_id, x.driver_id, x.ride_version, v_cut, v_ns, v_ne);
    perform public.enqueue_notification(x.driver_id, 'proposal_received', v_dept, v_week,
      jsonb_build_object('requesterName', coalesce(v_name, ''), 'day', public.day_date_label(x.starts_at),
        'timeRange', to_char(x.starts_at at time zone 'Asia/Jerusalem', 'HH24:MI') || '–' || to_char(x.ends_at at time zone 'Asia/Jerusalem', 'HH24:MI'),
        'oldTime', to_char((case v_cut when 'start' then x.starts_at else x.ends_at end) at time zone 'Asia/Jerusalem', 'HH24:MI'),
        'newTime', to_char(coalesce(v_ns, v_ne, x.ends_at) at time zone 'Asia/Jerusalem', 'HH24:MI'),
        'minutes', case v_cut when 'end' then (extract(epoch from x.ends_at - v_ne) / 60)::int
                              when 'start' then (extract(epoch from v_ns - x.starts_at) / 60)::int else 0 end),
      jsonb_build_object('ride_change_id', ch, 'ride_id', x.ride_id,
        'variant', case v_cut when 'end' then 'ride_shorten_end' when 'start' then 'ride_shorten_start' else 'ride_change' end),
      format('ride_change:%s:%s', ch, x.driver_id));
    cnt := cnt + 1;
  end loop;
  if cnt = 0 then raise exception 'no_conflicting_ride' using errcode = 'P0001'; end if;
  return ch;
end $$;
revoke all on function public.request_ride_shorten(uuid, uuid, uuid, timestamptz, timestamptz, integer, jsonb, boolean, boolean) from public;
grant execute on function public.request_ride_shorten(uuid, uuid, uuid, timestamptz, timestamptz, integer, jsonb, boolean, boolean) to authenticated;

-- The old "ask every driver to give up the ride" path is closed (REQ §13.203 a): an older app gets a clear refusal.
create or replace function public.request_ride_change(p_ride_id uuid, p_car_id uuid, p_starts_at timestamptz,
  p_ends_at timestamptz, p_expected_version integer, p_allow_small_trunk boolean default false)
returns uuid
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  raise exception 'ride_shorten_needs_talk' using errcode = 'P0001';
end $$;

-- Answering: when every asked driver accepted, their rides are shortened / given up as agreed and the requester's ride is
-- moved (or the new request placed) in one step, re-checked now; the requester hears the outcome.
create or replace function public.respond_ride_change_before_planning(p_change_id uuid, p_accept boolean)
returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  ch public.ride_change_requests%rowtype; r public.rides%rowtype; party record; q public.requests%rowtype;
  v_prev text := coalesce(current_setting('app.system_status_transition', true), 'off');
  v_name text; v_car text; v_ok boolean := true;
begin
  select * into ch from public.ride_change_requests where id = p_change_id for update;
  if not found then raise exception 'ride_change_not_found'; end if;
  if not public.is_approved() or not exists (select 1 from public.ride_change_parties where change_id = ch.id and profile_id = (select auth.uid())) then
    raise exception 'not_authorized';
  end if;
  if ch.status <> 'pending' then raise exception 'ride_change_not_pending'; end if;
  if ch.starts_at <= now() then update public.ride_change_requests set status = 'cancelled' where id = ch.id; return; end if;
  update public.ride_change_parties set accepted = p_accept, responded_at = now() where change_id = ch.id and profile_id = (select auth.uid());
  select full_name into v_name from public.profiles where id = (select auth.uid());
  if not p_accept then
    update public.ride_change_requests set status = 'declined' where id = ch.id;
    perform public._ride_shorten_tell_requester(ch, 'ride_shorten_declined', v_name);
    return;
  end if;
  if exists (select 1 from public.ride_change_parties where change_id = ch.id and accepted is distinct from true) then return; end if;

  perform 1 from public.rides where id = ch.ride_id or id in (select ride_id from public.ride_change_parties where change_id = ch.id) order by id for update;
  if ch.ride_id is not null then
    select * into r from public.rides where id = ch.ride_id;
    v_ok := r.version = ch.expected_version and r.status <> 'cancelled';
  else
    select * into q from public.requests where id = ch.request_id for update;
    v_ok := q.status = 'waitlisted' and q.version = ch.expected_version;
  end if;
  if not v_ok or exists (
    select 1 from public.ride_change_parties p join public.rides rd on rd.id = p.ride_id
    where p.change_id = ch.id and (rd.version <> p.expected_version or rd.status = 'cancelled')
  ) then
    update public.ride_change_requests set status = 'cancelled' where id = ch.id;
    return;
  end if;

  perform set_config('app.audit_reason', 'accepted_ride_change', true);
  if ch.allow_small_trunk then perform public._small_trunk_mode(true); end if;   -- REQ §13.111 (a): the proposer's waiver
  perform set_config('app.system_status_transition', 'on', true);
  begin
    for party in select * from public.ride_change_parties where change_id = ch.id loop
      if party.cut in ('end', 'start') then
        update public.rides set starts_at = coalesce(party.new_starts_at, starts_at), ends_at = coalesce(party.new_ends_at, ends_at),
          is_pinned = true, pin_reason = 'MEMBER_EDIT'
        where id = party.ride_id;
      else
        update public.rides set status = 'cancelled', cancelled_at = now(), cancelled_by = party.profile_id, cancel_reason = 'ACCEPTED_RIDE_CHANGE' where id = party.ride_id;
        update public.requests set status = 'cancelled', status_reason = 'RIDE_CANCELLED' where id in (select request_id from public.ride_requests where ride_id = party.ride_id);
        delete from public.ride_requests where ride_id = party.ride_id;
      end if;
    end loop;
    if ch.ride_id is not null then
      update public.rides set car_id = ch.car_id, starts_at = ch.starts_at, ends_at = ch.ends_at, is_pinned = true, pin_reason = 'MEMBER_EDIT' where id = ch.ride_id;
      perform public.assert_ride_request_day(ch.ride_id);
      perform public.assert_ride_seats_fit(ch.ride_id);
      perform public.assert_car_chain(ch.car_id, ch.week_start);
      if r.car_id <> ch.car_id then perform public.assert_car_chain(r.car_id, ch.week_start); end if;
    else
      perform public.place_request_on_car(q.id, ch.car_id, true, q.requester_id, null, q.depart_at, q.return_at, 'MEMBER_PLACED');
    end if;
  exception when others then
    -- Something changed since the request was sent (the car, the request, a turnaround): nothing changes.
    v_ok := false;
  end;
  perform set_config('app.system_status_transition', v_prev, true);
  if not v_ok then
    update public.ride_change_requests set status = 'cancelled' where id = ch.id;
    return;
  end if;
  update public.ride_change_requests set status = 'accepted' where id = ch.id;
  perform public._ride_shorten_tell_requester(ch, 'ride_shorten_accepted', v_name);
end $$;

-- One notice to whoever asked (REQ §13.203 c). Older requests (sent before the talk rule) stay silent, as before.
create or replace function public._ride_shorten_tell_requester(ch public.ride_change_requests, p_variant text, p_party_name text)
returns void
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if not ch.talked then return; end if;
  perform public.enqueue_notification(ch.requester_id, 'outcome_changed', ch.department_id, ch.week_start,
    jsonb_build_object('partyName', coalesce(p_party_name, ''), 'day', public.day_date_label(ch.starts_at),
      'timeRange', to_char(ch.starts_at at time zone 'Asia/Jerusalem', 'HH24:MI') || '–' || to_char(ch.ends_at at time zone 'Asia/Jerusalem', 'HH24:MI'),
      'car', coalesce((select name from public.cars where id = ch.car_id), '')),
    jsonb_strip_nulls(jsonb_build_object('variant', p_variant, 'ride_id', ch.ride_id, 'request_id', ch.request_id)),
    format('%s:%s:%s', p_variant, ch.id, (select auth.uid())));
end $$;
revoke all on function public._ride_shorten_tell_requester(public.ride_change_requests, text, text) from public;

-- REQ §13.203 (d): a new request's ask closes when the request leaves the waiting list by any other path.
create or replace function public.requests_close_ride_shorten()
returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if current_setting('app.audit_reason', true) = 'accepted_ride_change' then return new; end if;
  update public.ride_change_requests set status = 'cancelled', closed_reason = 'ride_moved'
  where request_id = new.id and status = 'pending';
  return new;
end $$;
revoke all on function public.requests_close_ride_shorten() from public;

create trigger requests_close_ride_shorten after update of status on public.requests
  for each row when (old.status = 'waitlisted' and new.status is distinct from 'waitlisted')
  execute function public.requests_close_ride_shorten();
