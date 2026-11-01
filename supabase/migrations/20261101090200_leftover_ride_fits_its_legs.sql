-- QA run 17 R17B6 (same family as R16B6): when the host/driver leaves a ride and others continue on it, the ride kept
-- the host's whole window (a lone 11:30 drop-off held the car 11:30–15:00). _fit_ride_to_its_legs gives the ride the
-- window its remaining legs need — a whole-trip leg its own hours, a single chauffeur leg the chauffeur length
-- (chauffeur_ride_minutes, as place_request_on_car), another single leg its route — and keeps it when that cannot
-- be computed, leaves the day, or the car is not free (the rides trigger refuses an overlap).
create or replace function public._fit_ride_to_its_legs(p_ride_id uuid) returns boolean
language plpgsql security definer set search_path = public, pg_temp as $$
declare r public.rides%rowtype; x record; v_s timestamptz; v_e timestamptz; ls timestamptz; le timestamptz; v_day date; v_min int;
begin
  select * into r from public.rides where id = p_ride_id;
  if not found or r.status = 'cancelled' or r.series_id is not null then return false; end if;
  v_day := (r.starts_at at time zone 'Asia/Jerusalem')::date;
  for x in select q.id, q.depart_at, q.return_at, rr.leg as rleg, rr.car_mode as rmode
           from public.ride_requests rr join public.requests q on q.id = rr.request_id where rr.ride_id = r.id loop
    ls := null; le := null;
    if x.rleg = 'both' then
      ls := x.depart_at; le := x.return_at;
    elsif x.rleg in ('out', 'return') then
      v_min := case when x.rmode = 'chauffeur' then public.chauffeur_ride_minutes(x.id, x.rleg)
                    else ceil(greatest(coalesce(public.request_leg_route_minutes(x.id, x.rleg), 30), 15) / 15.0)::int * 15 end;
      if x.rleg = 'out' and x.depart_at is not null then ls := x.depart_at; le := x.depart_at + make_interval(mins => v_min);
      elsif x.rleg = 'return' and x.return_at is not null then le := x.return_at; ls := x.return_at - make_interval(mins => v_min);
      end if;
    end if;
    if ls is null or le is null then return false; end if;
    v_s := least(coalesce(v_s, ls), ls); v_e := greatest(coalesce(v_e, le), le);
  end loop;
  if v_s is null or v_e <= v_s or (v_s, v_e) = (r.starts_at, r.ends_at) then return false; end if;
  if (v_s at time zone 'Asia/Jerusalem')::date <> v_day or ((v_e - interval '1 minute') at time zone 'Asia/Jerusalem')::date <> v_day then
    return false;
  end if;
  begin
    update public.rides set starts_at = v_s, ends_at = v_e where id = r.id;
    perform public.assert_ride_seats_fit(r.id);
  exception when others then
    return false;
  end;
  return true;
end $$;
revoke all on function public._fit_ride_to_its_legs(uuid) from public;

create or replace function public.cancel_ride_before_series("p_ride_id" "uuid", "p_reason" "text", "p_expected_version" integer DEFAULT NULL::integer) RETURNS "void"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
declare r public.rides%rowtype; v_gone record; own_requests uuid[]; passenger record; v_driver_name text; v_legs jsonb;
  v_new_start timestamptz; v_new_end timestamptz; v_pick record; v_new_driver uuid; v_new_name text;
begin
  select * into r from public.rides where id=p_ride_id for update;
  if not found or r.status='cancelled' then raise exception 'ride_not_found'; end if;
  if not public.is_approved() then raise exception 'not_authorized'; end if;
  if p_expected_version is null or r.version<>p_expected_version then perform public.raise_stale_version(); end if;
  if exists(select 1 from public.weeks where department_id=r.department_id and week_start=r.week_start and phase='archived') then raise exception 'week_archived'; end if;
  if r.driver_id is distinct from (select auth.uid()) and not public.can_manage_week(r.department_id,r.week_start) then
    select array_agg(q.id) into own_requests from public.ride_requests rr join public.requests q on q.id=rr.request_id where rr.ride_id=r.id and q.requester_id=(select auth.uid()) and rr.role='passenger';
    if coalesce(cardinality(own_requests),0)=0 then raise exception 'not_authorized'; end if;
    perform set_config('app.audit_reason','passenger_cancelled_own_request',true);
    select coalesce(jsonb_agg(jsonb_build_object('request_id', request_id, 'leg', leg)), '[]'::jsonb) into v_legs
    from public.ride_requests where ride_id=r.id and request_id=any(own_requests);
    delete from public.ride_requests where ride_id=r.id and request_id=any(own_requests);
    perform set_config('app.system_status_transition','on',true);
    -- REQ §13.104 (R4B8): cancelling one leg of a הקפצה ENDS that leg: the request keeps only its other leg (the cancelled
    -- leg's time is kept in kept_return_at / original_depart_at) instead of returning the leg to the unmet list.
    for v_gone in select cl.request_id, cl.leg from jsonb_to_recordset(v_legs) as cl(request_id uuid, leg public.ride_leg) join public.requests q on q.id=cl.request_id
      where q.trip_type='drop_off' and q.trip_shape='round_trip' and q.series_id is null and cl.leg in ('out','return')
        and exists(select 1 from public.ride_requests rr join public.rides rd on rd.id=rr.ride_id where rr.request_id=q.id and rd.status<>'cancelled' and rd.id<>r.id) loop
      if v_gone.leg='return' then
        update public.requests set trip_shape='one_way_to', needs_car_at_destination=false, kept_return_at=return_at, return_at=null,
          one_way_car_mode=case when (select does_not_drive from public.profiles where id=requester_id) then 'passenger'::public.leg_car_mode else 'relay'::public.leg_car_mode end
        where id=v_gone.request_id;
      else
        update public.requests set trip_shape='one_way_from', needs_car_at_destination=false, depart_at=null,
          one_way_car_mode=case when (select does_not_drive from public.profiles where id=requester_id) then 'passenger'::public.leg_car_mode else 'relay'::public.leg_car_mode end
        where id=v_gone.request_id;
      end if;
    end loop;
    update public.requests q set status='cancelled',status_reason='RIDE_CANCELLED' where q.id=any(own_requests)
      and not exists(select 1 from public.ride_requests rr join public.rides rd on rd.id=rr.ride_id where rr.request_id=q.id and rd.status<>'cancelled');
    -- REQ §13.103 R3B12: a ride nobody is left on is released; the driver is always told who left.
    if not exists(select 1 from public.ride_requests where ride_id=r.id) and not exists(select 1 from public.ride_passengers where ride_id=r.id) then
      update public.rides set status='cancelled',cancelled_at=now(),cancelled_by=(select auth.uid()),cancel_reason=coalesce(p_reason,'PASSENGER_CANCELLED') where id=r.id;
      perform public.flag_car_chain_breaks(r.car_id,r.week_start);
      perform public._offer_freed_slot(r.id);   -- R8B11: the released slot is offered like any cancellation
    else
      update public.rides set is_pinned=true, pin_reason=coalesce(pin_reason,'PASSENGER_CANCELLED') where id=r.id;   -- rides_pin_reason_ck
    end if;
    if r.driver_id is not null and r.driver_id is distinct from (select auth.uid()) then
      select string_agg(p.full_name,', ') into v_driver_name from public.profiles p where p.id=(select auth.uid());
      perform public._notify_rider_left(r.driver_id,r.id,v_driver_name,coalesce(public.request_route_label(own_requests[1]),''),
        public.day_date_label(r.starts_at),format('passenger_left:%s:%s:%s',r.id,own_requests[1],r.version));
    end if;
    perform set_config('app.system_status_transition','off',true);
    return;
  end if;
  -- R7B9 follow-up: a driverless ride (a ride that already needs a driver, a car move) has no driver to hand
  -- over, so cancelling it simply cancels it (the Sadran is the only caller that gets here).
  if r.needs_driver then
    perform public.cancel_ride_without_passengers(p_ride_id,p_reason,p_expected_version);return;
  end if;
  if not exists(select 1 from public.ride_requests rr join public.requests q on q.id=rr.request_id where rr.ride_id=r.id and q.requester_id is distinct from r.driver_id) then
    perform public.cancel_ride_without_passengers(p_ride_id,p_reason,p_expected_version);return;
  end if;
  perform set_config('app.audit_reason',coalesce(p_reason,'driver_cancelled_passengers_retained'),true);
  perform set_config('app.system_status_transition','on',true);
  select array_agg(q.id) into own_requests from public.ride_requests rr join public.requests q on q.id=rr.request_id where rr.ride_id=r.id and q.requester_id=r.driver_id;
  delete from public.ride_requests where ride_id=r.id and request_id=any(own_requests);
  update public.requests set status='cancelled',status_reason='RIDE_CANCELLED' where id=any(own_requests);
  update public.rides set driver_id=null,needs_driver=true,is_pinned=true,pin_reason='MISSING_DRIVER',
    status=case when status='draft' then 'draft'::public.ride_status else 'flagged'::public.ride_status end,flag_reason='NEEDS_DRIVER' where id=r.id;
  update public.requests set status='waitlisted',status_reason='UNMET_NEEDS_DRIVER' where id in(select request_id from public.ride_requests where ride_id=r.id);
  -- R13B12 (owner 2026-10-23): the ride now serves only the guests, so it takes their own times instead of the driver's;
  -- R17B6: a guest on one leg only (a drop-off, a pickup) gets that leg's length, not the driver's whole window. Skipped
  -- when the car cannot take it. A guest who drives (a round trip on the whole ride) then becomes its driver.
  perform public._fit_ride_to_its_legs(r.id);
  select q.id, q.requester_id into v_pick
  from public.ride_requests rr join public.requests q on q.id=rr.request_id join public.profiles p on p.id=q.requester_id
  where rr.ride_id=r.id and rr.leg='both' and q.trip_type='round_trip' and not coalesce(p.does_not_drive,false)
  order by q.depart_at, q.id limit 1;
  if v_pick.id is not null then
    begin
      update public.rides set driver_id=v_pick.requester_id, needs_driver=false, pin_reason='SADRAN_MANUAL',
        status=r.status, flag_reason=r.flag_reason where id=r.id;
      update public.ride_requests set role='driver', car_mode='keep' where ride_id=r.id and request_id=v_pick.id;
      update public.requests set status='assigned', status_reason='GUEST_NOW_DRIVES' where id=v_pick.id;
      update public.requests set status='merged', status_reason='GUEST_NOW_DRIVES'
      where id in (select request_id from public.ride_requests where ride_id=r.id) and id<>v_pick.id;
      perform public.assert_ride_driver(r.id);
      v_new_driver := v_pick.requester_id;
    exception when others then
      v_new_driver := null;   -- e.g. a seat rule: the ride stays held for a volunteer driver
    end;
  end if;
  select full_name into v_driver_name from public.profiles where id = r.driver_id;
  if v_new_driver is not null then
    select full_name into v_new_name from public.profiles where id = v_new_driver;
    for passenger in select q.requester_id from public.ride_requests rr join public.requests q on q.id=rr.request_id where rr.ride_id=r.id
        union select rp.person_id from public.ride_passengers rp where rp.ride_id=r.id and rp.person_id is not null loop
      continue when passenger.requester_id is not distinct from r.driver_id;
      perform public.enqueue_notification(passenger.requester_id,'outcome_changed',r.department_id,r.week_start,
        jsonb_build_object('driverName',coalesce(v_driver_name,''),'byName',coalesce(v_driver_name,''),'newDriver',coalesce(v_new_name,'')),
        jsonb_build_object('ride_id',r.id,'variant',case when passenger.requester_id=v_new_driver then 'driver_cancelled_you_drive' else 'driver_cancelled_new_driver' end),
        format('driver_cancelled:%s:%s:%s',r.id,r.version,passenger.requester_id));
    end loop;
    perform public.enqueue_notification(s.profile_id,'outcome_changed',r.department_id,r.week_start,
      jsonb_build_object('driverName',coalesce(v_driver_name,''),'byName',coalesce(v_driver_name,''),'newDriver',coalesce(v_new_name,'')),
      jsonb_build_object('ride_id',r.id,'variant','driver_cancelled_sadran_new_driver'),
      format('driver_cancelled_sadran:%s:%s:%s',r.id,r.version,s.profile_id))
    from public.sadranim_of(r.department_id,r.week_start) as s(profile_id)
    where s.profile_id is distinct from (select auth.uid());
    perform set_config('app.system_status_transition','off',true);
    return;
  end if;
  if r.origin_id<>r.destination_id then
    update public.rides set status=case when status='draft' then 'draft'::public.ride_status else 'flagged'::public.ride_status end,flag_reason='relay_driver_missing'
    where car_id=r.car_id and week_start=r.week_start and id<>r.id and status<>'cancelled' and starts_at>=r.ends_at;
  end if;
  perform public.assert_ride_driver(r.id);perform public.assert_ride_seats_fit(r.id);
  -- REQ §13.100 (QB6): each remaining passenger is told the driver cancelled and that the ride is
  -- still held but needs a driver; the Sadran of the week is told too.
  select full_name into v_driver_name from public.profiles where id = r.driver_id;
  for passenger in select q.id,q.requester_id,q.freed_slot_opt_out from public.ride_requests rr join public.requests q on q.id=rr.request_id where rr.ride_id=r.id loop
    perform public.enqueue_notification(passenger.requester_id,'outcome_changed',r.department_id,r.week_start,
      jsonb_build_object('driverName',coalesce(v_driver_name,''),'byName',coalesce(v_driver_name,'')),
      jsonb_build_object('request_id',passenger.id,'ride_id',r.id,'needs_driver',true,
        'variant',case when passenger.freed_slot_opt_out then 'driver_cancelled_plain' else 'driver_cancelled' end),
      format('driver_cancelled:%s:%s:%s',r.id,r.version,passenger.id));
  end loop;
  for passenger in select rp.person_id as requester_id from public.ride_passengers rp
      where rp.ride_id=r.id and rp.person_id is not null and rp.person_id is distinct from r.driver_id
        and not exists(select 1 from public.ride_requests rr join public.requests q on q.id=rr.request_id where rr.ride_id=r.id and q.requester_id=rp.person_id) loop
    perform public.enqueue_notification(passenger.requester_id,'outcome_changed',r.department_id,r.week_start,
      jsonb_build_object('driverName',coalesce(v_driver_name,''),'byName',coalesce(v_driver_name,'')),
      jsonb_build_object('ride_id',r.id,'needs_driver',true,'variant','driver_cancelled_plain'),
      format('driver_cancelled:%s:%s:%s',r.id,r.version,passenger.requester_id));
  end loop;
  perform public.enqueue_notification(s.profile_id,'outcome_changed',r.department_id,r.week_start,
    jsonb_build_object('driverName',coalesce(v_driver_name,''),'byName',coalesce(v_driver_name,'')),
    jsonb_build_object('ride_id',r.id,'needs_driver',true,'variant','driver_cancelled_sadran'),
    format('driver_cancelled_sadran:%s:%s:%s',r.id,r.version,s.profile_id))
  from public.sadranim_of(r.department_id,r.week_start) as s(profile_id)
  where s.profile_id is distinct from (select auth.uid());
  perform set_config('app.system_status_transition','off',true);
end $$;

create or replace function public.sadran_cancel_ride("p_ride_id" "uuid", "p_reason" "text", "p_expected_version" integer, "p_close_request_ids" "uuid"[] DEFAULT '{}'::"uuid"[], "p_continue_request_ids" "uuid"[] DEFAULT '{}'::"uuid"[]) RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
declare
  r public.rides%rowtype; v_actor uuid := (select auth.uid()); v_by text;
  v_reason text := nullif(btrim(coalesce(p_reason, '')), '');
  v_rides uuid[]; v_served uuid[]; v_close uuid[]; v_keep uuid[]; v_continue uuid[]; v_closed uuid[] := '{}'; v_id uuid;
  v_is_relay boolean; v_who record; v_car record; v_offer uuid; v_rd public.rides%rowtype; v_name text;
  v_status public.request_status; v_status_reason text;
  v_prev_notify text := coalesce(nullif(current_setting('app.notify_now', true), ''), 'off');
  v_prev_sys text := coalesce(current_setting('app.system_status_transition', true), 'off');
begin
  select * into r from public.rides where id = p_ride_id for update;
  if r.id is null or r.status = 'cancelled' then raise exception 'ride_not_found' using errcode = 'P0001'; end if;
  if not public.can_manage_week(r.department_id, r.week_start) then raise exception 'not_authorized' using errcode = 'P0001'; end if;
  if p_expected_version is null or r.version <> p_expected_version then perform public.raise_stale_version(); end if;
  if exists (select 1 from public.weeks where department_id = r.department_id and week_start = r.week_start and phase = 'archived') then
    raise exception 'week_archived' using errcode = 'P0001';
  end if;
  perform set_config('app.audit_reason', coalesce(v_reason, 'sadran_cancel_ride'), true);
  -- R15M2: in a live week a cancellation reaches the people on the ride at once, even when made on the board.
  if exists (select 1 from public.weeks w where w.department_id = r.department_id and w.week_start = r.week_start and w.phase = 'live') then
    perform set_config('app.notify_now', 'on', true);
  end if;

  -- A series ride is cancelled on every day (as cancel_ride does); the choice per person covers the whole series.
  select array_agg(id order by starts_at, id) into v_rides from public.rides
  where status <> 'cancelled' and (id = r.id or (r.series_id is not null and series_id = r.series_id));
  select coalesce(array_agg(distinct q.id), '{}') into v_served
  from public.ride_requests rr join public.requests q on q.id = rr.request_id
  where rr.ride_id = any(v_rides) and q.status not in ('draft', 'withdrawn', 'cancelled');
  if exists (select 1 from unnest(coalesce(p_close_request_ids, '{}') || coalesce(p_continue_request_ids, '{}')) c(id)
             where c.id <> all(v_served)) then
    raise exception 'request_not_on_ride' using errcode = 'P0001';
  end if;
  if coalesce(p_close_request_ids, '{}') && coalesce(p_continue_request_ids, '{}') then
    raise exception 'request_choice_conflict' using errcode = 'P0001';
  end if;
  select coalesce(array_agg(q.id), '{}') into v_close from public.requests q
  where q.id = any(v_served) and (q.id = any(coalesce(p_close_request_ids, '{}')) or (q.series_id is not null and q.series_id in (
    select c.series_id from public.requests c where c.id = any(coalesce(p_close_request_ids, '{}')) and c.series_id is not null)));
  select coalesce(array_agg(id), '{}') into v_continue from unnest(v_served) s(id)
  where id = any(coalesce(p_continue_request_ids, '{}')) and id <> all(v_close);
  select coalesce(array_agg(id), '{}') into v_keep from unnest(v_served) s(id) where id <> all(v_close) and id <> all(v_continue);
  select exists (select 1 from public.ride_requests where ride_id = any(v_rides) and car_mode = 'relay') into v_is_relay;
  select full_name into v_by from public.profiles where id = v_actor;
  if cardinality(v_continue) > 0 and cardinality(v_keep) + cardinality(v_close) = 0 then
    raise exception 'nothing_to_cancel' using errcode = 'P0001';
  end if;

  -- "להשאיר ברשימת ההמתנה": one notice per member (the existing R14B1 copy: "removed from the ride, back on the
  -- waiting list"), told before the ride changes (as unassign_ride does, so a held notice keeps the ride's before-view).
  for v_who in
    select distinct on (q.requester_id) q.id as request_id, q.requester_id
    from public.requests q where q.id = any(v_keep) and q.requester_id is distinct from v_actor
    order by q.requester_id, (exists (select 1 from public.ride_requests rr where rr.ride_id = r.id and rr.request_id = q.id)) desc, q.id
  loop
    perform public.enqueue_notification(v_who.requester_id, 'outcome_changed', r.department_id, r.week_start,
      jsonb_build_object('byName', coalesce(v_by, '')),
      jsonb_build_object('variant', 'unassigned_by_sadran', 'request_id', v_who.request_id, 'ride_id', r.id),
      format('unassigned_by_sadran:%s:%s:%s', r.id, v_who.request_id, clock_timestamp()));
  end loop;

  if cardinality(v_continue) > 0 then
    -- O29-2 (3) "ממשיך/ה בנסיעה": the ride stays; every request that leaves is taken off it, ride by ride, first.
    -- R16B5: a closed one too, before _close_request releases the rest of its bookings - on an unpublished day that
    -- release (release_request_draft_rides) cancels every draft ride the request is on, which took the continuing
    -- requests' legs with it.
    foreach v_id in array v_keep || v_close loop
      select status, status_reason into v_status, v_status_reason from public.requests where id = v_id;
      for v_rd in select rd.* from public.rides rd where rd.id = any(v_rides) and rd.status <> 'cancelled'
                    and exists (select 1 from public.ride_requests rr where rr.ride_id = rd.id and rr.request_id = v_id)
                  order by rd.starts_at, rd.id for update loop
        if v_rd.driver_id is not null and v_rd.driver_id = (select requester_id from public.requests where id = v_id) then
          -- the driver leaves: as a host who cancels (a driving guest takes over, else needs a driver)
          perform public.cancel_ride_before_series(v_rd.id, coalesce(v_reason, 'SADRAN_EDIT'), v_rd.version);
          -- (it ends the driver's own request as RIDE_CANCELLED; the Sadran's choice - wait or close - decides below)
          perform set_config('app.system_status_transition', 'on', true);
          update public.requests set status = v_status, status_reason = v_status_reason where id = v_id;
          perform set_config('app.system_status_transition', v_prev_sys, true);
        else
          perform set_config('app.system_status_transition', 'on', true);
          delete from public.ride_requests where ride_id = v_rd.id and request_id = v_id;
          update public.rides set is_pinned = true, pin_reason = coalesce(pin_reason, 'SADRAN_MANUAL') where id = v_rd.id;
          perform set_config('app.system_status_transition', v_prev_sys, true);
          if v_rd.driver_id is not null and v_rd.driver_id is distinct from v_actor then
            select p.full_name into v_name from public.requests q join public.profiles p on p.id = q.requester_id where q.id = v_id;
            perform public._notify_rider_left(v_rd.driver_id, v_rd.id, v_name, coalesce(public.request_route_label(v_id), ''),
              public.day_date_label(v_rd.starts_at), format('passenger_left:%s:%s:%s', v_rd.id, v_id, v_rd.version));
          end if;
        end if;
      end loop;
    end loop;
    -- R17B6: each ride the others continue on takes the window their own legs need.
    perform public._fit_ride_to_its_legs(rd.id) from public.rides rd where rd.id = any(v_rides) and rd.status <> 'cancelled';
    perform set_config('app.audit_reason', coalesce(v_reason, 'sadran_cancel_ride'), true);
    perform set_config('app.system_status_transition', 'on', true);
    update public.requests q set status = 'waitlisted', status_reason = 'SADRAN_UNASSIGNED'
    where q.id = any(v_keep)
      and not exists (select 1 from public.ride_requests rr join public.rides rd on rd.id = rr.ride_id
                      where rr.request_id = q.id and rd.status <> 'cancelled');
    perform set_config('app.system_status_transition', v_prev_sys, true);
  else
    -- Named people on the ride with no request of their own (as unassign_ride / cancel_ride).
    for v_who in
      select distinct rp.person_id from public.ride_passengers rp
      where rp.ride_id = any(v_rides) and rp.person_id is not null and rp.person_id is distinct from v_actor
        and not exists (select 1 from public.requests q where q.id = any(v_served) and q.requester_id = rp.person_id)
    loop
      perform public.enqueue_notification(v_who.person_id, 'outcome_changed', r.department_id, r.week_start,
        jsonb_build_object('byName', coalesce(v_by, '')),
        jsonb_build_object('variant', 'ride_cancelled', 'ride_id', r.id),
        format('ride_cancelled:%s:%s:%s', r.id, r.version, v_who.person_id));
    end loop;

    perform set_config('app.system_status_transition', 'on', true);
    update public.rides set status = 'cancelled', cancelled_at = now(), cancelled_by = v_actor,
      cancel_reason = coalesce(v_reason, 'SADRAN_EDIT')
    where id = any(v_rides);
    delete from public.ride_requests where ride_id = any(v_rides);
    -- back on the waiting list unless another live ride still carries it (a הקפצה's other leg: it keeps that leg)
    update public.requests q set status = 'waitlisted', status_reason = 'SADRAN_UNASSIGNED'
    where q.id = any(v_keep)
      and not exists (select 1 from public.ride_requests rr join public.rides rd on rd.id = rr.ride_id
                      where rr.request_id = q.id and rd.status <> 'cancelled');
    perform set_config('app.system_status_transition', v_prev_sys, true);
  end if;

  -- "הנסיעה כבר לא רלוונטית": closed with everything it still holds; one notice per member.
  foreach v_id in array v_close loop
    continue when v_id = any(v_closed);
    -- (a release inside may have changed it; the closing row carries the Sadran's reason)
    perform set_config('app.audit_reason', coalesce(v_reason, 'sadran_cancel_ride'), true);
    v_closed := v_closed || public._close_request(v_id);
  end loop;
  for v_who in
    select distinct on (q.requester_id) q.id as request_id
    from public.requests q where q.id = any(v_close)
    order by q.requester_id, (q.id = any(coalesce(p_close_request_ids, '{}'))) desc, q.id
  loop
    perform public._notify_request_closed(v_who.request_id, v_reason);
  end loop;

  -- REQ §13.89: heal what the cancelled rides left on their cars; R2B6: flag what now starts where the car is not.
  for v_car in select distinct rd.car_id, rd.week_start from public.rides rd where rd.id = any(v_rides) loop
    if cardinality(v_continue) = 0 then
      perform set_config('app.chain_hint', jsonb_build_object('origin_id', r.origin_id, 'destination_id', r.destination_id,
        'starts_at', r.starts_at, 'ends_at', r.ends_at)::text, true);
    end if;
    perform public.assert_car_chain(v_car.car_id, v_car.week_start);
    perform public.flag_car_chain_breaks(v_car.car_id, v_car.week_start);
  end loop;
  if cardinality(v_continue) = 0 and r.series_id is null and not v_is_relay then
    v_offer := public._offer_freed_slot(r.id);
    -- RC1B3 (owner 2026-10-29): "keep on the waiting list" means the Sadran took them off this car - its freed
    -- car is offered to everyone else waiting (pg_net sends the offer only after this transaction commits).
    if v_offer is not null and cardinality(v_keep) > 0 then
      update public.freed_slot_offers set excluded_request_ids = v_keep where id = v_offer;
    end if;
  end if;

  perform set_config('app.notify_now', v_prev_notify, true);
  return jsonb_build_object('ride_id', r.id, 'closed', to_jsonb(v_closed), 'waitlisted', to_jsonb(v_keep),
    'continuing', to_jsonb(v_continue), 'ride_kept', cardinality(v_continue) > 0);
end $$;
