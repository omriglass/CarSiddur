-- REQ §13.103 R3B12: a passenger cancelling their own request on a ride tells the driver (variant passenger_left) and releases an emptied ride.
create or replace function public."cancel_ride_before_series"("p_ride_id" "uuid", "p_reason" "text", "p_expected_version" integer DEFAULT NULL::integer) RETURNS "void"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
declare r public.rides%rowtype; own_requests uuid[]; passenger record; v_driver_name text;
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
    delete from public.ride_requests where ride_id=r.id and request_id=any(own_requests);
    perform set_config('app.system_status_transition','on',true);
    update public.requests q set status='cancelled',status_reason='RIDE_CANCELLED' where q.id=any(own_requests)
      and not exists(select 1 from public.ride_requests rr join public.rides rd on rd.id=rr.ride_id where rr.request_id=q.id and rd.status<>'cancelled');
    -- REQ §13.103 R3B12: a ride nobody is left on is released; the driver is always told who left.
    if not exists(select 1 from public.ride_requests where ride_id=r.id) and not exists(select 1 from public.ride_passengers where ride_id=r.id) then
      update public.rides set status='cancelled',cancelled_at=now(),cancelled_by=(select auth.uid()),cancel_reason=coalesce(p_reason,'PASSENGER_CANCELLED') where id=r.id;
      perform public.flag_car_chain_breaks(r.car_id,r.week_start);
    else
      update public.rides set is_pinned=true where id=r.id;
    end if;
    if r.driver_id is not null and r.driver_id is distinct from (select auth.uid()) then
      select string_agg(p.full_name,', ') into v_driver_name from public.profiles p where p.id=(select auth.uid());
      perform public.enqueue_notification(r.driver_id,'outcome_changed',r.department_id,r.week_start,
        jsonb_build_object('names',coalesce(v_driver_name,''),'route',coalesce(public.request_route_label(own_requests[1]),''),
          'day',public.day_date_label(r.starts_at)),
        jsonb_build_object('variant','passenger_left','ride_id',r.id,'request_id',own_requests[1]),
        format('passenger_left:%s:%s:%s',r.id,own_requests[1],r.version));
    end if;
    perform set_config('app.system_status_transition','off',true);
    return;
  end if;
  if r.needs_driver then raise exception 'ride_already_needs_driver'; end if;
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


ALTER FUNCTION public."cancel_ride_before_series"("p_ride_id" "uuid", "p_reason" "text", "p_expected_version" integer) OWNER TO "postgres";


create or replace function public."cancel_ride_change"("p_change_id" "uuid") RETURNS "void"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
begin
  if exists(select 1 from public.ride_change_requests c where c.id=p_change_id and c.is_planning
    and not public.can_manage_week(c.department_id,c.week_start)) then raise exception 'not_authorized'; end if;
  perform public.cancel_ride_change_before_planning(p_change_id);
end $$;


ALTER FUNCTION public."cancel_ride_change"("p_change_id" "uuid") OWNER TO "postgres";


create or replace function public."cancel_ride_change_before_planning"("p_change_id" "uuid") RETURNS "void"
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


ALTER FUNCTION public."cancel_ride_change_before_planning"("p_change_id" "uuid") OWNER TO "postgres";


create or replace function public."cancel_ride_without_passengers"("p_ride_id" "uuid", "p_reason" "text", "p_expected_version" integer DEFAULT NULL::integer) RETURNS "void"
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
      and not public.ride_is_reservation(id);
    return;
  end if;

  -- REQ §13.99: nothing is ever offered from a private (temporary) car; only shared cars free a slot.
  if v_ride.origin_id = v_ride.destination_id
     and exists (select 1 from public.cars c where c.id = v_ride.car_id and c.type = 'shared') then
    -- REQ §13.102 (b): the offer covers the car's whole free gap that day (previous ride end + turnaround
    -- ... next ride start - turnaround), not only the cancelled ride's own hours. A neighbour that does not
    -- leave/expect the car at this ride's place bounds the gap at the cancelled ride itself.
    v_ta := make_interval(mins => coalesce(public.required_turnaround_minutes(v_ride.department_id, v_ride.week_start), 30));
    v_day_start := ((v_ride.starts_at at time zone 'Asia/Jerusalem')::date)::timestamp at time zone 'Asia/Jerusalem';
    v_day_end := (((v_ride.starts_at at time zone 'Asia/Jerusalem')::date + 1)::timestamp at time zone 'Asia/Jerusalem') - interval '1 minute';
    select r.ends_at, r.destination_id into v_prev from public.rides r
    where r.car_id = v_ride.car_id and r.status <> 'cancelled' and r.id <> p_ride_id and r.ends_at <= v_ride.starts_at
      and r.ends_at >= v_day_start and not r.planning_conflict
    order by r.ends_at desc limit 1;
    select r.starts_at, r.origin_id into v_next from public.rides r
    where r.car_id = v_ride.car_id and r.status <> 'cancelled' and r.id <> p_ride_id and r.starts_at >= v_ride.ends_at
      and r.starts_at <= v_day_end and not r.planning_conflict
    order by r.starts_at limit 1;
    select min(b.starts_at) into v_maint from public.car_maintenance_blocks b
    where b.car_id = v_ride.car_id and b.starts_at >= v_ride.ends_at and b.starts_at <= v_day_end;
    v_gap_start := case when v_prev.ends_at is null then v_day_start
                        when v_prev.destination_id is distinct from v_ride.origin_id then v_ride.starts_at
                        else least(v_prev.ends_at + v_ta, v_ride.starts_at) end;
    v_gap_end := case when v_next.starts_at is null then v_day_end
                      when v_next.origin_id is distinct from v_ride.destination_id then v_ride.ends_at
                      else greatest(v_next.starts_at - v_ta, v_ride.ends_at) end;
    if v_maint is not null then v_gap_end := greatest(least(v_gap_end, v_maint), v_ride.ends_at); end if;
    insert into public.freed_slot_offers (department_id, week_start, car_id, cancelled_ride_id, starts_at, ends_at, expires_at)
    values (v_ride.department_id, v_ride.week_start, v_ride.car_id, p_ride_id, v_gap_start, v_gap_end, v_ride.starts_at)
    returning id into v_offer_id;

    -- Notify the on-ride-cancelled edge function (pg_net) if configured; a no-op locally
    -- until app_settings.on_ride_cancelled_url is set, so this never breaks db reset/tests.
    perform net.http_post(
      url := cfg.url_val,
      headers := jsonb_build_object('Content-Type', 'application/json', 'x-cron-secret', coalesce(cfg.secret_val, '')),
      body := jsonb_build_object('offer_id', v_offer_id)
    )
    from (
      select
        (select value ->> 'value' from public.app_settings where key = 'on_ride_cancelled_url') as url_val,
        (select value ->> 'value' from public.app_secrets where key = 'cron_secret') as secret_val
    ) cfg
    where cfg.url_val is not null and cfg.url_val <> '';
  end if;
end;
$$;

