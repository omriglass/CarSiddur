-- Live one-way quick-add reserves an available car while a driver is still needed.
-- REQ §8; DATA_MODEL missing-driver bookings.
create function public.reserve_live_one_way_slot(p_request_id uuid) returns jsonb
security definer set search_path=public,pg_temp language plpgsql as $$
declare q public.requests%rowtype; c record; home uuid; duration_minutes int; travel int; dwell int;
  start_time timestamptz;end_time timestamptz;buffer_minutes int;ride_id uuid;
begin
  select * into q from public.requests where id=p_request_id for update;
  if not found or q.requester_id is distinct from (select auth.uid()) or not public.member_of(q.department_id)
    or q.trip_shape='round_trip' or q.one_way_car_mode<>'passenger' or not exists(select 1 from public.weeks where department_id=q.department_id and week_start=q.week_start and phase='live')
    or exists(select 1 from public.ride_requests where request_id=q.id) then raise exception 'invalid_quick_reservation';end if;
  select d.home_destination_id,coalesce((w.settings_overrides->>'chauffeur_dwell_minutes')::int,s.chauffeur_dwell_minutes,10)
    into home,dwell from public.departments d join public.department_settings s on s.department_id=d.id
    join public.weeks w on w.department_id=d.id and w.week_start=q.week_start where d.id=q.department_id;
  select coalesce(travel_minutes,30) into travel from public.destinations where id=q.destination_id;
  travel:=greatest(coalesce(travel,30),0);
  duration_minutes:=greatest(15,ceil((2*travel+greatest(dwell,0))/15.0)::int*15);
  if q.trip_shape='one_way_to' then start_time:=q.depart_at;end_time:=q.depart_at+make_interval(mins=>duration_minutes);
  else end_time:=q.return_at;start_time:=q.return_at-make_interval(mins=>duration_minutes);end if;
  if start_time<now() then raise exception 'ride_in_past';end if;
  if start_time<q.week_start::timestamp at time zone 'Asia/Jerusalem'
    or end_time>(q.week_start+7)::timestamp at time zone 'Asia/Jerusalem' then raise exception 'ride_outside_week';end if;
  if (start_time at time zone 'Asia/Jerusalem')::date<>(coalesce(q.depart_at,q.return_at) at time zone 'Asia/Jerusalem')::date then raise exception 'ride_request_day_mismatch';end if;
  buffer_minutes:=coalesce(public.required_turnaround_minutes(q.department_id,q.week_start),30);
  perform set_config('app.audit_reason','reserve_live_one_way_slot',true);
  perform set_config('app.system_status_transition','on',true);
  if home is not null then
    for c in select car.id from public.cars car where car.department_id=q.department_id and car.status='active' and car.type='shared'
      and exists(select 1 from public.car_seat_configs seats where seats.car_id=car.id and seats.adults>=q.adults+1 and seats.child_seats>=q.child_seats and seats.boosters>=q.boosters)
      order by (car.id=q.preferred_car_id) desc nulls last,car.id loop
      -- A car being reserved by another transaction is temporarily unavailable; try the next one.
      if not pg_try_advisory_xact_lock(hashtextextended(c.id::text,0)) then continue;end if;
      perform 1 from public.cars where id=c.id and status='active' and type='shared' for share;
      if not found or public.car_location_at(c.id,start_time) is distinct from home
        or exists(select 1 from public.rides r where r.car_id=c.id and r.status<>'cancelled'
          and tstzrange(r.starts_at,r.blocked_until,'[)') && tstzrange(start_time,end_time+make_interval(mins=>buffer_minutes),'[)'))
        or exists(select 1 from public.car_maintenance_blocks b where b.car_id=c.id
          and tstzrange(b.starts_at,b.ends_at,'[)') && tstzrange(start_time,end_time+make_interval(mins=>buffer_minutes),'[)')) then continue;end if;
      begin
        insert into public.rides(department_id,week_start,car_id,starts_at,ends_at,origin_id,destination_id,driver_id,needs_driver,status,is_pinned,pin_reason,created_by)
          values(q.department_id,q.week_start,c.id,start_time,end_time,home,home,null,true,'confirmed',true,'MISSING_DRIVER',q.requester_id) returning id into ride_id;
        insert into public.ride_requests(ride_id,request_id,role,leg,car_mode)
          values(ride_id,q.id,'passenger',case when q.trip_shape='one_way_to' then 'out'::public.ride_leg else 'return'::public.ride_leg end,'chauffeur');
        perform public.assert_ride_driver(ride_id);perform public.assert_ride_request_day(ride_id);
        perform public.assert_ride_seats_fit(ride_id);perform public.assert_car_chain(c.id,q.week_start);
        update public.requests set status='waitlisted',status_reason='UNMET_NEEDS_DRIVER' where id=q.id;
        perform set_config('app.system_status_transition','off',true);
        return jsonb_build_object('status','waitlisted','reason','UNMET_NEEDS_DRIVER','needs_driver',true,'ride_id',ride_id,'car_id',c.id,'starts_at',start_time,'ends_at',end_time);
      exception when exclusion_violation or sqlstate 'P0410' or sqlstate 'P0411' then null;
      end;
    end loop;
  end if;
  update public.requests set status='waitlisted',status_reason='WAITLISTED_NO_CAR' where id=q.id;
  perform set_config('app.system_status_transition','off',true);
  return jsonb_build_object('status','waitlisted','reason','WAITLISTED_NO_CAR','needs_driver',false);
end $$;
revoke execute on function public.reserve_live_one_way_slot(uuid) from public,anon,authenticated;

do $migration$
declare def text:=pg_get_functiondef('public.submit_request(jsonb)'::regprocedure);old_text text;
begin
  old_text:='  if v_request_id is not null then perform public.release_request_draft_rides(v_request_id); end if;';
  if strpos(def,old_text)=0 then raise exception 'unexpected_submit_quick_guard';end if;
  def:=replace(def,old_text,$$  if coalesce((payload->>'reserve_missing_driver')::boolean,false) and (
    v_request_id is not null or v_requester_id is distinct from v_actor or v_week.phase<>'live' or v_trip_shape='round_trip' or v_one_way_mode is distinct from 'passenger'::public.leg_car_mode or v_join_ride_id is not null
  ) then raise exception 'invalid_quick_reservation';end if;
$$||old_text);
  old_text:=$$  if v_week.phase = 'live' and v_trip_shape = 'round_trip' then$$;
  if strpos(def,old_text)=0 then raise exception 'unexpected_submit_live_branch';end if;
  def:=replace(def,old_text,$$  if coalesce((payload->>'reserve_missing_driver')::boolean,false) then
    v_auto_result:=public.reserve_live_one_way_slot(v_request_id);
    perform public.enqueue_notification(s.profile_id,'waitlisted_request',v_department_id,v_week_start,
      jsonb_build_object('requestId',v_request_id::text),jsonb_build_object('request_id',v_request_id,'ride_id',v_auto_result->>'ride_id'),
      format('waitlisted_request:%s',v_request_id)) from public.sadranim_of(v_department_id,v_week_start) as s(profile_id);
  elsif v_week.phase = 'live' and v_trip_shape = 'round_trip' then$$);
  execute def;
end;
$migration$;
