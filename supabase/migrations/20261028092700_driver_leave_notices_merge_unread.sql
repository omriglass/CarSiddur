-- R14B10 follow-up (owner 2026-10-23, "merge if unread"): the DRIVER's "X לא נוסע/ת איתך יותר" notices (a passenger cancelling
-- their own seat in cancel_ride_before_series, release_request_booking) now go through the same helper as the riders'
-- (_notify_rider_left): one notice naming everyone who left, replaced while unread, inbox only when the earlier one was unopened.
-- Only the notify call changed in both functions.

CREATE OR REPLACE FUNCTION "public"."cancel_ride_before_series"("p_ride_id" "uuid", "p_reason" "text", "p_expected_version" integer DEFAULT NULL::integer) RETURNS "void"
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
  -- R13B12 (owner 2026-10-23): the ride now serves only the guests, so it takes their own times (earliest departure to
  -- latest return) instead of the driver's; and a guest who drives (a round trip on the whole ride, not marked "does
  -- not drive") becomes its driver. Each step is tried on its own and skipped when the car cannot take it.
  select min(q.depart_at), max(q.return_at) into v_new_start, v_new_end
  from public.ride_requests rr join public.requests q on q.id=rr.request_id
  where rr.ride_id=r.id and q.depart_at is not null and q.return_at is not null;
  if v_new_start is not null and v_new_end > v_new_start
     and (v_new_start at time zone 'Asia/Jerusalem')::date=(r.starts_at at time zone 'Asia/Jerusalem')::date
     and ((v_new_end - interval '1 minute') at time zone 'Asia/Jerusalem')::date=(r.starts_at at time zone 'Asia/Jerusalem')::date
     and (v_new_start, v_new_end) is distinct from (r.starts_at, r.ends_at) then
    begin
      update public.rides set starts_at=v_new_start, ends_at=v_new_end where id=r.id;
      perform public.assert_ride_seats_fit(r.id);
    exception when others then
      null;   -- the car is not free for the guests' own times: the ride keeps its window
    end;
  end if;
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


ALTER FUNCTION "public"."cancel_ride_before_series"("p_ride_id" "uuid", "p_reason" "text", "p_expected_version" integer) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."cancel_ride_change"("p_change_id" "uuid") RETURNS "void"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
begin
  if exists(select 1 from public.ride_change_requests c where c.id=p_change_id and c.is_planning
    and not public.can_manage_week(c.department_id,c.week_start)) then raise exception 'not_authorized'; end if;
  perform public.cancel_ride_change_before_planning(p_change_id);
end $$;


ALTER FUNCTION "public"."cancel_ride_change"("p_change_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."cancel_ride_change_before_planning"("p_change_id" "uuid") RETURNS "void"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
declare ch public.ride_change_requests%rowtype;
begin
  select * into ch from public.ride_change_requests where id=p_change_id for update;
  if not found then raise exception 'ride_change_not_found'; end if;
  if not public.is_approved() or (ch.requester_id is distinct from (select auth.uid()) and not public.can_manage_week(ch.department_id,ch.week_start)) then raise exception 'not_authorized'; end if;
  if ch.status<>'pending' then raise exception 'ride_change_not_pending'; end if;
  update public.ride_change_requests set status='cancelled' where id=ch.id;
end $$;


ALTER FUNCTION "public"."cancel_ride_change_before_planning"("p_change_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."cancel_ride_without_passengers"("p_ride_id" "uuid", "p_reason" "text", "p_expected_version" integer DEFAULT NULL::integer) RETURNS "void"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
declare
  v_ride record;
  v_is_relay boolean;
  v_offer_id uuid;
  v_actor uuid := (select auth.uid());
  v_actor_name text;
  v_served record;
  v_passenger record;
  v_ta interval; v_day_start timestamptz; v_day_end timestamptz;
  v_prev record; v_next record; v_gap_start timestamptz; v_gap_end timestamptz; v_maint timestamptz;
begin
  select * into v_ride from public.rides where id = p_ride_id for update;
  if v_ride is null or v_ride.status = 'cancelled' then raise exception 'ride_not_found' using errcode = 'P0001'; end if;
  if v_ride.driver_id <> v_actor and not public.can_manage_week(v_ride.department_id, v_ride.week_start) then
    raise exception 'not_authorized' using errcode = 'P0001';
  end if;
  if p_expected_version is null or v_ride.version <> p_expected_version then
    perform public.raise_stale_version();
  end if;

  perform set_config('app.audit_reason', coalesce(p_reason, 'cancel_ride'), true);

  select exists (select 1 from public.ride_requests rr where rr.ride_id = p_ride_id and rr.car_mode = 'relay')
    into v_is_relay;

  update public.rides set status = 'cancelled', cancelled_at = now(), cancelled_by = v_actor,
    cancel_reason = coalesce(p_reason, 'CANCELLED_BY_MEMBER')
  where id = p_ride_id;

  select full_name into v_actor_name from public.profiles where id = v_actor;

  for v_served in
    select q.id as request_id, q.requester_id
    from public.ride_requests rr join public.requests q on q.id = rr.request_id
    where rr.ride_id = p_ride_id and q.requester_id is distinct from v_actor
      and q.status not in ('cancelled', 'withdrawn')   -- R7B9/R7U4: nobody is told about a request that already ended
  loop
    perform public.enqueue_notification(v_served.requester_id, 'outcome_changed', v_ride.department_id, v_ride.week_start,
      jsonb_build_object('byName', coalesce(v_actor_name, '')),
      jsonb_build_object('variant', 'ride_cancelled', 'ride_id', p_ride_id, 'request_id', v_served.request_id),
      format('ride_cancelled:%s:%s:%s', p_ride_id, v_ride.version, v_served.request_id));
  end loop;

  -- Named ride_passengers (F3, 20260914120000): no `requests` row of their own, so they are
  -- never reached by the loop above — notify them the same way.
  for v_passenger in
    select rp.person_id
    from public.ride_passengers rp
    where rp.ride_id = p_ride_id and rp.person_id is not null and rp.person_id is distinct from v_actor
  loop
    perform public.enqueue_notification(v_passenger.person_id, 'outcome_changed', v_ride.department_id, v_ride.week_start,
      jsonb_build_object('byName', coalesce(v_actor_name, '')),
      jsonb_build_object('variant', 'ride_cancelled', 'ride_id', p_ride_id),
      format('ride_cancelled:%s:%s:%s', p_ride_id, v_ride.version, v_passenger.person_id));
  end loop;

  update public.requests set status = 'cancelled', status_reason = 'RIDE_CANCELLED'
  where id in (select request_id from public.ride_requests where ride_id = p_ride_id);

  -- REQ §13.89: heal the chain of the car this ride just vacated, reusing its own
  -- origin/destination/times as the hint for whichever gap its removal opened up.
  perform set_config('app.chain_hint', jsonb_build_object('origin_id',v_ride.origin_id,'destination_id',v_ride.destination_id,
    'starts_at',v_ride.starts_at,'ends_at',v_ride.ends_at)::text, true);
  perform public.assert_car_chain(v_ride.car_id, v_ride.week_start);
  -- R2B6: whatever the removal left starting where the car is not gets flagged for the Sadran.
  perform public.flag_car_chain_breaks(v_ride.car_id, v_ride.week_start);

  if v_is_relay then
    -- Still flag the partner leg for the Sadran's attention (REQ §13.63) — the chain
    -- itself is already healed by the assert_car_chain call above.
    update public.rides set status = 'flagged', flag_reason = 'relay_pair_cancelled'
    where car_id = v_ride.car_id and week_start = v_ride.week_start and status <> 'cancelled'
      and (origin_id = v_ride.destination_id or destination_id = v_ride.origin_id) and id <> p_ride_id
      and not needs_driver   -- a driverless ride keeps its NEEDS_DRIVER flag
      and not public.ride_is_reservation(id);
    return;
  end if;

  perform public._offer_freed_slot(p_ride_id);
end;
$$;

CREATE OR REPLACE FUNCTION "public"."release_request_booking"("p_request_id" "uuid") RETURNS "void"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
declare
  v_req public.requests%rowtype; r public.rides%rowtype; v_ride_id uuid; v_actor uuid := (select auth.uid());
  v_names text; v_prev text;
begin
  select * into v_req from public.requests where id = p_request_id;
  if v_req.id is null then raise exception 'request_not_found' using errcode = 'P0001'; end if;
  perform public.release_request_draft_rides(p_request_id);
  for v_ride_id in
    select rd.id from public.ride_requests rr join public.rides rd on rd.id = rr.ride_id
    where rr.request_id = p_request_id and rd.status not in ('cancelled', 'draft') order by rd.id
  loop
    select * into r from public.rides where id = v_ride_id for update;
    if r.status = 'cancelled' then continue; end if;
    if r.driver_id is not distinct from v_req.requester_id then
      perform public.cancel_ride_before_series(r.id, 'REQUEST_RELEASED', r.version);
    else
      v_prev := coalesce(current_setting('app.system_status_transition', true), 'off');
      perform set_config('app.audit_reason', 'request_released', true);
      perform set_config('app.system_status_transition', 'on', true);
      delete from public.ride_requests where ride_id = r.id and request_id = p_request_id;
      if not exists (select 1 from public.ride_requests where ride_id = r.id)
         and not exists (select 1 from public.ride_passengers where ride_id = r.id) then
        update public.rides set status = 'cancelled', cancelled_at = now(), cancelled_by = v_actor,
          cancel_reason = 'REQUEST_RELEASED' where id = r.id;
        perform public.flag_car_chain_breaks(r.car_id, r.week_start);   -- R2B6
        perform public._offer_freed_slot(r.id);   -- R8B11
      else
        -- R13B19: a pinned ride needs a reason (rides_pin_reason_ck); keep the one it has.
        update public.rides set is_pinned = true, pin_reason = coalesce(pin_reason, 'REQUEST_RELEASED') where id = r.id;
      end if;
      perform set_config('app.system_status_transition', v_prev, true);
      if r.driver_id is not null then
        select full_name into v_names from public.profiles where id = v_req.requester_id;
        perform public._notify_rider_left(r.driver_id, r.id, v_names, coalesce(public.request_route_label(p_request_id), ''),
          public.day_date_label(r.starts_at), format('passenger_left:%s:%s:%s', r.id, p_request_id, r.version));
      end if;
    end if;
  end loop;
  -- a released request keeps no link to a ride it is no longer on (a later placement needs the slot free)
  delete from public.ride_requests rr using public.rides rd
  where rr.request_id = p_request_id and rd.id = rr.ride_id and rd.status = 'cancelled';
end $$;


ALTER FUNCTION "public"."release_request_booking"("p_request_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."release_request_draft_rides"("p_request_id" "uuid") RETURNS "void"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
declare r record; ids uuid[];
begin
  perform set_config('app.system_status_transition','on',true);
  for r in select rd.* from public.rides rd join public.ride_requests rr on rr.ride_id=rd.id where rr.request_id=p_request_id and rd.status='draft' order by rd.id for update of rd loop
    select array_agg(request_id) into ids from public.ride_requests where ride_id=r.id;
    update public.rides set status='cancelled',cancelled_at=now(),cancelled_by=(select auth.uid()),cancel_reason='REQUEST_EDITED' where id=r.id;
    delete from public.ride_requests where ride_id=r.id;
    update public.requests q set status='submitted',status_reason=null where id=any(ids) and not exists(
      select 1 from public.ride_requests rr join public.rides rd on rd.id=rr.ride_id where rr.request_id=q.id and rd.status<>'cancelled');
  end loop;
  perform set_config('app.system_status_transition','off',true);
end $$;


ALTER FUNCTION "public"."release_request_draft_rides"("p_request_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."remind_unsent_board_changes"("p_now" timestamp with time zone DEFAULT "now"()) RETURNS "void"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
declare
  r record;
begin
  for r in
    select x.actor, x.department_id, x.week_start, max(x.created_at) as newest_due
    from (
      select h.actor_id as actor, h.department_id, h.week_start, h.created_at from public.held_notices h where h.actor_id is not null
      union all
      select p.created_by, p.department_id, p.week_start, p.created_at from public.proposals p
      where p.status = 'draft' and p.created_via = 'sadran' and p.created_by is not null
    ) x
    join public.department_settings ds on ds.department_id = x.department_id
    join public.weeks w on w.department_id = x.department_id and w.week_start = x.week_start and w.phase <> 'archived'
    where x.created_at <= p_now - make_interval(mins => ds.send_all_reminder_minutes)
    group by x.actor, x.department_id, x.week_start
  loop
    if exists (select 1 from public.unsent_change_reminders u
               where u.profile_id = r.actor and u.department_id = r.department_id and u.week_start = r.week_start
                 and u.last_reminded_at >= r.newest_due) then
      continue;
    end if;
    perform public.enqueue_notification(r.actor, 'publish_reminder', r.department_id, r.week_start, '{}'::jsonb,
      jsonb_build_object('variant', 'unsent_changes', 'url', format('/sadran/%s/%s/board', r.department_id, r.week_start)),
      format('unsent_changes:%s:%s:%s:%s', r.actor, r.department_id, r.week_start, extract(epoch from p_now)));
    insert into public.unsent_change_reminders (profile_id, department_id, week_start, last_reminded_at)
    values (r.actor, r.department_id, r.week_start, p_now)
    on conflict (profile_id, department_id, week_start) do update set last_reminded_at = excluded.last_reminded_at;
  end loop;
end $$;


ALTER FUNCTION "public"."remind_unsent_board_changes"("p_now" timestamp with time zone) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."remove_ride_person"("p_ride_id" "uuid", "p_expected_version" integer, "p_key" "text") RETURNS "void"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
declare
  v_ride public.rides%rowtype;
  v_actor uuid := (select auth.uid());
  v_actor_name text;
  v_destination_name text;
  v_route text;
  v_prefix text;
  v_request_id uuid;
  v_profile_id uuid;
  v_child_id uuid;
  v_ride_passenger_id uuid;
  v_n int;
  v_display_name text;
  v_new_version int;
  v_removed_person_id uuid;
  v_removed_child_id uuid;
  v_removed_display_name text;
  v_skip_notify boolean := false;
  v_guardian record;
begin
  select * into v_ride from public.rides where id = p_ride_id for update;
  if not found or v_ride.status = 'cancelled' then raise exception 'ride_not_found' using errcode = 'P0001'; end if;

  if not public.member_of(v_ride.department_id) then
    raise exception 'not_authorized' using errcode = 'P0001';
  end if;
  if not (public.is_week_public(v_ride.department_id, v_ride.week_start) or public.can_manage_week(v_ride.department_id, v_ride.week_start)) then
    raise exception 'ride_week_not_public' using errcode = 'P0001';
  end if;

  if p_expected_version is null or v_ride.version <> p_expected_version then
    perform public.raise_stale_version();
  end if;

  if exists (select 1 from public.weeks where department_id = v_ride.department_id and week_start = v_ride.week_start and phase = 'archived') then
    raise exception 'week_archived' using errcode = 'P0001';
  end if;

  v_prefix := split_part(coalesce(p_key, ''), ':', 1);
  perform set_config('app.audit_reason', 'remove_ride_person', true);

  if v_prefix = 'driver' then
    raise exception 'ride_driver_not_removable' using errcode = 'P0001';

  elsif v_prefix = 'added' then
    v_ride_passenger_id := nullif(split_part(p_key, ':', 2), '')::uuid;
    select person_id, child_id, display_name into v_removed_person_id, v_removed_child_id, v_removed_display_name
    from public.ride_passengers where id = v_ride_passenger_id and ride_id = p_ride_id;
    if not found then raise exception 'ride_not_found' using errcode = 'P0001'; end if;
    delete from public.ride_passengers where id = v_ride_passenger_id;
    v_skip_notify := v_removed_person_id is null and v_removed_child_id is null; -- free-text guest

  elsif v_prefix = 'comp' then
    v_request_id := nullif(split_part(p_key, ':', 2), '')::uuid;
    v_profile_id := nullif(split_part(p_key, ':', 3), '')::uuid;
    if v_request_id is null or v_profile_id is null
      or not exists (select 1 from public.ride_requests where ride_id = p_ride_id and request_id = v_request_id)
    then
      raise exception 'ride_not_found' using errcode = 'P0001';
    end if;
    select full_name into v_removed_display_name from public.profiles where id = v_profile_id;
    delete from public.request_companions where request_id = v_request_id and profile_id = v_profile_id;
    update public.requests set updated_at = now() where id = v_request_id;
    v_removed_person_id := v_profile_id;

  elsif v_prefix = 'child' then
    v_request_id := nullif(split_part(p_key, ':', 2), '')::uuid;
    v_child_id := nullif(split_part(p_key, ':', 3), '')::uuid;
    if v_request_id is null or v_child_id is null
      or not exists (select 1 from public.ride_requests where ride_id = p_ride_id and request_id = v_request_id)
    then
      raise exception 'ride_not_found' using errcode = 'P0001';
    end if;
    select full_name into v_removed_display_name from public.children where id = v_child_id;
    delete from public.request_children where request_id = v_request_id and child_id = v_child_id;
    update public.requests set updated_at = now() where id = v_request_id;
    v_removed_child_id := v_child_id;

  elsif v_prefix = 'guest' then
    v_request_id := nullif(split_part(p_key, ':', 2), '')::uuid;
    v_n := nullif(split_part(p_key, ':', 3), '')::int;
    if v_request_id is null or v_n is null or v_n < 1
      or not exists (select 1 from public.ride_requests where ride_id = p_ride_id and request_id = v_request_id)
    then
      raise exception 'ride_not_found' using errcode = 'P0001';
    end if;
    update public.requests
      set guest_passenger_names = guest_passenger_names[1 : v_n - 1] || guest_passenger_names[v_n + 1 : cardinality(guest_passenger_names)]
      where id = v_request_id and v_n <= cardinality(guest_passenger_names);
    if not found then raise exception 'ride_not_found' using errcode = 'P0001'; end if;
    v_skip_notify := true; -- free-text guest: nobody is notified

  elsif v_prefix = 'req' then
    v_request_id := nullif(split_part(p_key, ':', 2), '')::uuid;
    if v_request_id is null then raise exception 'ride_not_found' using errcode = 'P0001'; end if;
    select requester_id into v_profile_id from public.requests where id = v_request_id;
    if v_profile_id is null
      or not exists (select 1 from public.ride_requests where ride_id = p_ride_id and request_id = v_request_id)
    then
      raise exception 'ride_not_found' using errcode = 'P0001';
    end if;
    if v_profile_id = v_ride.driver_id then
      raise exception 'ride_driver_not_removable' using errcode = 'P0001';
    end if;
    select full_name into v_removed_display_name from public.profiles where id = v_profile_id;
    delete from public.ride_requests where ride_id = p_ride_id and request_id = v_request_id;
    perform set_config('app.system_status_transition', 'on', true);
    update public.requests set status = 'withdrawn', status_reason = 'WITHDRAWN_BY_MEMBER' where id = v_request_id;
    perform set_config('app.system_status_transition', 'off', true);
    v_removed_person_id := v_profile_id;

  else
    raise exception 'invalid_ride_passenger' using errcode = 'P0001';
  end if;

  update public.rides set updated_at = now() where id = p_ride_id
  returning version into v_new_version;

  if not v_skip_notify then
    select full_name into v_actor_name from public.profiles where id = v_actor;

    -- The driver is always told who was removed, unless the driver is the one removing them.
    if v_ride.driver_id is not null and v_ride.driver_id is distinct from v_actor then
      perform public.enqueue_notification(v_ride.driver_id, 'outcome_changed', v_ride.department_id, v_ride.week_start,
        jsonb_build_object('byName', coalesce(v_actor_name, ''), 'names', coalesce(v_removed_display_name, '')),
        jsonb_build_object('variant', 'passengers_removed', 'ride_id', p_ride_id),
        format('passengers_removed:%s:%s:%s', p_ride_id, v_new_version, v_ride.driver_id));
    end if;

    if v_removed_person_id is not null and v_removed_person_id is distinct from v_actor then
      select name into v_destination_name from public.destinations where id = v_ride.destination_id;
      v_route := public.route_label(v_ride.department_id, v_ride.origin_id, null, v_ride.destination_id, null);
      perform public.enqueue_notification(v_removed_person_id, 'outcome_changed', v_ride.department_id, v_ride.week_start,
        jsonb_build_object('byName', coalesce(v_actor_name, ''), 'destination', coalesce(v_destination_name, ''), 'route', coalesce(v_route, '')),
        jsonb_build_object('variant', case when v_prefix = 'req' then 'passenger_removed_request' else 'passenger_removed_you' end, 'ride_id', p_ride_id),
        format('passenger_removed_you:%s:%s:%s', p_ride_id, v_new_version, v_removed_person_id));
    end if;

    if v_removed_child_id is not null then
      select name into v_destination_name from public.destinations where id = v_ride.destination_id;
      v_route := public.route_label(v_ride.department_id, v_ride.origin_id, null, v_ride.destination_id, null);
      for v_guardian in select cg.profile_id from public.child_guardians cg where cg.child_id = v_removed_child_id loop
        if v_guardian.profile_id is distinct from v_actor then
          perform public.enqueue_notification(v_guardian.profile_id, 'outcome_changed', v_ride.department_id, v_ride.week_start,
            jsonb_build_object('byName', coalesce(v_actor_name, ''), 'childName', coalesce(v_removed_display_name, ''), 'destination', coalesce(v_destination_name, ''), 'route', coalesce(v_route, '')),
            jsonb_build_object('variant', 'child_removed', 'ride_id', p_ride_id),
            format('child_removed:%s:%s:%s:%s', p_ride_id, v_new_version, v_removed_child_id, v_guardian.profile_id));
        end if;
      end loop;
    end if;
  end if;
end;
$$;
