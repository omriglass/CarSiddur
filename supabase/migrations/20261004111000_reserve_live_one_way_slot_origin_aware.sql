-- O3 (REQ §13.93, ORIGINS_PLAN §3): reserve_live_one_way_slot() (the live-week quick
-- missing-driver reservation for a drop_off-without-pickup request) now reserves at the
-- request's own origin instead of always the department home -- "origin = where the car is at
-- that time" (ORIGINS_PLAN §3). A free-text origin is never auto-placed, same as everywhere
-- else in this step. Travel time comes from place_travel(origin, destination) instead of the
-- destination's own home-anchored `travel_minutes`. Full create-or-replace (hard rule 8).
create or replace function public.reserve_live_one_way_slot(p_request_id uuid) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare q public.requests%rowtype; c record; dwell int; duration_minutes int; travel int;
  start_time timestamptz; end_time timestamptz; buffer_minutes int; ride_id uuid;
begin
  select * into q from public.requests where id=p_request_id for update;
  if not found or q.requester_id is distinct from (select auth.uid()) or not public.member_of(q.department_id)
    or q.trip_shape='round_trip' or not exists(select 1 from public.weeks where department_id=q.department_id and week_start=q.week_start and phase='live')
    or exists(select 1 from public.ride_requests where request_id=q.id) then raise exception 'invalid_quick_reservation';end if;
  select coalesce((w.settings_overrides->>'chauffeur_dwell_minutes')::int,s.chauffeur_dwell_minutes,10)
    into dwell from public.department_settings s
    join public.weeks w on w.department_id=s.department_id and w.week_start=q.week_start where s.department_id=q.department_id;
  select travel_minutes into travel from public.place_travel(q.origin_id, q.destination_id);
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
  if q.origin_id is not null then
    for c in select car.id from public.cars car where car.department_id=q.department_id and car.status='active' and car.type='shared'
      and exists(select 1 from public.car_seat_configs seats where seats.car_id=car.id and seats.adults>=q.adults+1 and seats.child_seats>=q.child_seats and seats.boosters>=q.boosters)
      order by (car.id=q.preferred_car_id) desc nulls last,car.id loop
      -- A car being reserved by another transaction is temporarily unavailable; try the next one.
      if not pg_try_advisory_xact_lock(hashtextextended(c.id::text,0)) then continue;end if;
      perform 1 from public.cars where id=c.id and status='active' and type='shared' for share;
      if not found or public.car_location_at(c.id,start_time) is distinct from q.origin_id
        or exists(select 1 from public.rides r where r.car_id=c.id and r.status<>'cancelled'
          and tstzrange(r.starts_at,r.blocked_until,'[)') && tstzrange(start_time,end_time+make_interval(mins=>buffer_minutes),'[)'))
        or exists(select 1 from public.car_maintenance_blocks b where b.car_id=c.id
          and tstzrange(b.starts_at,b.ends_at,'[)') && tstzrange(start_time,end_time+make_interval(mins=>buffer_minutes),'[)')) then continue;end if;
      begin
        insert into public.rides(department_id,week_start,car_id,starts_at,ends_at,origin_id,destination_id,driver_id,needs_driver,status,is_pinned,pin_reason,created_by)
          values(q.department_id,q.week_start,c.id,start_time,end_time,q.origin_id,q.origin_id,null,true,'confirmed',true,'MISSING_DRIVER',q.requester_id) returning id into ride_id;
        insert into public.ride_requests(ride_id,request_id,role,leg,car_mode)
          values(ride_id,q.id,'passenger',case when q.trip_shape='one_way_to' then 'out'::public.ride_leg else 'return'::public.ride_leg end,'chauffeur');
        perform public.assert_ride_driver(ride_id);perform public.assert_ride_request_day(ride_id);
        perform public.assert_ride_seats_fit(ride_id);perform public.assert_car_chain(c.id,q.week_start);
        -- REQ §13.88 (owner 2026-09-24): the chain check may have paired this leg with a matching
        -- leg at X (any non-overlapping gap now pairs) — then it is an ordinary driven relay leg,
        -- already `assigned`/RELAY_PAIRED by pair_one_way_legs(); report that instead.
        if exists(select 1 from public.ride_requests rr where rr.request_id=q.id and rr.car_mode='relay') then
          perform set_config('app.system_status_transition','off',true);
          return (select jsonb_build_object('status','assigned','reason','RELAY_PAIRED','needs_driver',false,'ride_id',r.id,'car_id',r.car_id,'starts_at',r.starts_at,'ends_at',r.ends_at)
                  from public.ride_requests rr join public.rides r on r.id=rr.ride_id where rr.request_id=q.id limit 1);
        end if;
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
