-- REQ §13.103 R3B8: a waiting/unplaced request the Sadran places onto a ride of a published day tells its requester.
create or replace function public."edit_ride_before_planning"("p_ride" "jsonb", "p_expected_version" integer DEFAULT NULL::integer) RETURNS "uuid"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
declare
  v_id uuid := nullif(p_ride->>'id', '')::uuid;
  v_dept uuid := (p_ride->>'department_id')::uuid;
  v_week date := (p_ride->>'week_start')::date;
  v_existing public.rides%rowtype;
  v_manage boolean;
  v_served jsonb;
  v_prev_status public.request_status; v_rq_requester uuid;
  v_old_requests uuid[];
  v_needs_driver boolean;
  v_override smallint;
  v_car_row public.cars%rowtype;
  v_one jsonb; v_req public.requests%rowtype; v_leg public.ride_leg; v_min int;
  v_s timestamptz; v_e timestamptz; v_day date;
begin
  if not public.is_approved() then raise exception 'not_authorized'; end if;
  if v_id is not null then
    select * into v_existing from public.rides where id = v_id for update;
    if not found then raise exception 'ride_not_found'; end if;
    if v_dept is distinct from v_existing.department_id or v_week is distinct from v_existing.week_start then raise exception 'not_authorized'; end if;
    if p_expected_version is null or v_existing.version <> p_expected_version then perform public.raise_stale_version(); end if;
    if v_existing.status = 'cancelled' then raise exception 'ride_not_found'; end if;
  end if;
  v_manage := public.can_manage_week(v_dept,v_week);
  if exists (select 1 from public.weeks where department_id=v_dept and week_start=v_week and phase='archived') then raise exception 'week_archived'; end if;
  if not v_manage then
    if v_id is null or v_existing.driver_id is distinct from (select auth.uid()) or not public.is_week_public(v_dept,v_week) then raise exception 'not_authorized'; end if;
    if (p_ride->>'starts_at')::timestamptz <= now() then raise exception 'ride_in_past'; end if;
    if (p_ride ? 'driver_id' and (p_ride->>'driver_id')::uuid is distinct from v_existing.driver_id)
      or (p_ride ? 'origin_id' and (p_ride->>'origin_id')::uuid is distinct from v_existing.origin_id)
      or (p_ride ? 'destination_id' and (p_ride->>'destination_id')::uuid is distinct from v_existing.destination_id)
      or ((p_ride->>'starts_at')::timestamptz at time zone 'Asia/Jerusalem')::date <> (v_existing.starts_at at time zone 'Asia/Jerusalem')::date
      or exists (select 1 from public.ride_requests rr join public.requests q on q.id=rr.request_id where rr.ride_id=v_id and (q.requester_id <> (select auth.uid()) or rr.car_mode <> 'keep'))
    then raise exception 'not_authorized'; end if;
  end if;
  if not exists (select 1 from public.cars where id=(p_ride->>'car_id')::uuid and status='active' and department_id=v_dept) then raise exception 'car_unavailable'; end if;
  -- REQ §13.99: only the owner puts requests on a private (temporary) car.
  select * into v_car_row from public.cars where id=(p_ride->>'car_id')::uuid;
  if v_car_row.type='temporary' and v_car_row.owner_id is distinct from (select auth.uid()) then
    if v_id is not null and v_existing.car_id is distinct from v_car_row.id then
      raise exception 'private_car_owner_only' using errcode='P0001';  -- moving a ride onto it
    elsif v_id is null and (jsonb_array_length(coalesce(p_ride->'served','[]'))=0 or exists(
        select 1 from jsonb_array_elements(p_ride->'served') s join public.requests q on q.id=(s->>'request_id')::uuid
        where q.requester_id is distinct from v_car_row.owner_id)) then
      raise exception 'private_car_owner_only' using errcode='P0001';  -- a new ride that is not the owner's own
    elsif v_id is not null and v_manage and p_ride ? 'served' and exists(
        select 1 from jsonb_array_elements(p_ride->'served') s join public.requests q on q.id=(s->>'request_id')::uuid
        where q.requester_id is distinct from v_car_row.owner_id
          and not exists(select 1 from public.ride_requests rr where rr.ride_id=v_id and rr.request_id=q.id)) then
      raise exception 'private_car_owner_only' using errcode='P0001';  -- adding someone else's request
    end if;
  end if;
  -- REQ §13.100 QB5: a single chauffeur leg of a drop-off request keeps a chauffeur-length window.
  if v_manage and jsonb_typeof(p_ride->'served')='array' and jsonb_array_length(p_ride->'served')=1
     and coalesce((p_ride->>'needs_driver')::boolean,false) then
    v_one:=p_ride->'served'->0;
    select * into v_req from public.requests where id=(v_one->>'request_id')::uuid;
    v_leg:=coalesce((v_one->>'leg')::public.ride_leg,'both');
    if v_req.id is not null and v_req.trip_type='drop_off' and v_leg in ('out','return')
       and coalesce(v_one->>'car_mode','')='chauffeur' then
      v_min:=public.chauffeur_ride_minutes(v_req.id,v_leg);
      v_s:=(p_ride->>'starts_at')::timestamptz; v_e:=(p_ride->>'ends_at')::timestamptz;
      v_day:=(v_s at time zone 'Asia/Jerusalem')::date;
      if extract(epoch from (v_e-v_s))/60 < v_min then
        if v_leg='out' then
          v_e:=v_s+make_interval(mins=>v_min);
          if (v_e at time zone 'Asia/Jerusalem')::date<>v_day then v_e:=((v_day+time '23:59') at time zone 'Asia/Jerusalem'); end if;
        else
          v_s:=v_e-make_interval(mins=>v_min);
          if (v_s at time zone 'Asia/Jerusalem')::date<>v_day then v_s:=(v_day::timestamp at time zone 'Asia/Jerusalem'); end if;
        end if;
        p_ride:=p_ride||jsonb_build_object('starts_at',v_s,'ends_at',v_e);
      end if;
    end if;
  end if;
  v_needs_driver:=case when v_manage then coalesce((p_ride->>'needs_driver')::boolean,v_existing.needs_driver,false) else false end;
  perform set_config('app.audit_reason','edit_ride',true);
  if v_manage then
    v_override:=public.prepare_manual_ride_window((p_ride->>'car_id')::uuid,v_week,(p_ride->>'starts_at')::timestamptz,(p_ride->>'ends_at')::timestamptz,v_id);
  end if;
  if v_id is null then
    insert into public.rides(department_id,week_start,car_id,starts_at,ends_at,origin_id,destination_id,driver_id,status,is_pinned,pin_reason,created_by,notes,needs_driver,turnaround_override_minutes)
    values(v_dept,v_week,(p_ride->>'car_id')::uuid,(p_ride->>'starts_at')::timestamptz,(p_ride->>'ends_at')::timestamptz,
      (p_ride->>'origin_id')::uuid,(p_ride->>'destination_id')::uuid,nullif(p_ride->>'driver_id','')::uuid,
      case when public.is_week_public(v_dept,v_week) then 'confirmed'::public.ride_status else 'draft'::public.ride_status end,
      true,coalesce(p_ride->>'pin_reason','SADRAN_MANUAL'),(select auth.uid()),nullif(trim(p_ride->>'notes'),''),v_needs_driver,v_override) returning id into v_id;
  else
    update public.rides set needs_driver=v_needs_driver,turnaround_override_minutes=v_override,car_id=(p_ride->>'car_id')::uuid,starts_at=(p_ride->>'starts_at')::timestamptz,ends_at=(p_ride->>'ends_at')::timestamptz,
      origin_id=coalesce((p_ride->>'origin_id')::uuid,origin_id),destination_id=coalesce((p_ride->>'destination_id')::uuid,destination_id),
      driver_id=case when v_manage and p_ride ? 'driver_id' then nullif(p_ride->>'driver_id','')::uuid else driver_id end,
      notes=case when v_manage and p_ride ? 'notes' then nullif(trim(p_ride->>'notes'),'') else notes end,
      overflow_allowed=case when v_manage then coalesce((p_ride->>'overflow_allowed')::boolean,overflow_allowed) else overflow_allowed end,
      overnight_ack_by=case when v_manage and (p_ride->>'overnight_ack')::boolean then (select auth.uid()) else overnight_ack_by end,
      overnight_ack_at=case when v_manage and (p_ride->>'overnight_ack')::boolean then now() else overnight_ack_at end,
      is_pinned=case when v_needs_driver then true when v_manage then coalesce((p_ride->>'is_pinned')::boolean,true) else true end,pin_reason=coalesce(p_ride->>'pin_reason',case when v_manage then 'SADRAN_EDIT' else 'MEMBER_EDIT' end)
    where id=v_id;
  end if;
  if v_manage and p_ride ? 'served' then
    select array_agg(request_id) into v_old_requests from public.ride_requests where ride_id=v_id;
    delete from public.ride_requests where ride_id=v_id;
    for v_served in select * from jsonb_array_elements(p_ride->'served') loop
      if exists (select 1 from public.rides where id=v_id and driver_id is null and not needs_driver) then raise exception 'reservation_cannot_serve_requests'; end if;
      select status, requester_id into v_prev_status, v_rq_requester from public.requests where id=(v_served->>'request_id')::uuid;
      insert into public.ride_requests(ride_id,request_id,role,leg,car_mode,detour_minutes)
      values(v_id,(v_served->>'request_id')::uuid,(v_served->>'role')::public.ride_role,
        coalesce((v_served->>'leg')::public.ride_leg,'both'),(v_served->>'car_mode')::public.leg_car_mode,coalesce((v_served->>'detour_minutes')::smallint,0));
      update public.requests set status=case when v_needs_driver then 'waitlisted'::public.request_status when v_served->>'role'='driver' then 'assigned'::public.request_status else 'merged'::public.request_status end,status_reason=case when v_needs_driver then 'UNMET_NEEDS_DRIVER' else 'SADRAN_ASSIGNED' end
      where id=(v_served->>'request_id')::uuid;
      if v_manage and not v_needs_driver and v_prev_status in ('waitlisted','submitted','proposed')
         and v_rq_requester is distinct from (select auth.uid())
         and public.is_day_public(v_dept,v_week,((p_ride->>'starts_at')::timestamptz at time zone 'Asia/Jerusalem')::date) then
        perform public.enqueue_notification(v_rq_requester,'outcome_changed',v_dept,v_week,'{}'::jsonb,
          jsonb_build_object('variant','edit_applied','request_id',(v_served->>'request_id')::uuid,'ride_id',v_id),
          format('placed_by_sadran:%s:%s',(v_served->>'request_id')::uuid,v_id));
      end if;
    end loop;
    update public.requests q set status='waitlisted',status_reason='SADRAN_UNASSIGNED'
    where q.id=any(v_old_requests) and not exists(select 1 from public.ride_requests rr join public.rides r on r.id=rr.ride_id where rr.request_id=q.id and r.status<>'cancelled');
  end if;
  perform public.assert_ride_driver(v_id);
  if v_manage then
    perform public.refresh_car_turnarounds((p_ride->>'car_id')::uuid,v_week);
    if v_existing.car_id is not null and v_existing.car_id<>(p_ride->>'car_id')::uuid then perform public.refresh_car_turnarounds(v_existing.car_id,v_week); end if;
  end if;
  perform public.assert_ride_request_day(v_id);
  perform public.assert_ride_seats_fit(v_id);
  perform public.assert_car_chain((p_ride->>'car_id')::uuid,v_week);
  if v_existing.car_id is not null and v_existing.car_id<>(p_ride->>'car_id')::uuid then perform public.assert_car_chain(v_existing.car_id,v_week); end if;
  return v_id;
end $$;


ALTER FUNCTION public."edit_ride_before_planning"("p_ride" "jsonb", "p_expected_version" integer) OWNER TO "postgres";


create or replace function public."edit_ride_before_series"("p_ride" "jsonb", "p_expected_version" integer DEFAULT NULL::integer) RETURNS "uuid"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
declare existing public.rides%rowtype; v_id uuid:=nullif(p_ride->>'id','')::uuid;
  v_dept uuid:=(p_ride->>'department_id')::uuid; v_week date:=(p_ride->>'week_start')::date;
  v_car uuid:=(p_ride->>'car_id')::uuid; v_start timestamptz:=(p_ride->>'starts_at')::timestamptz;
  v_end timestamptz:=(p_ride->>'ends_at')::timestamptz; wants_planning boolean:=coalesce((p_ride->>'allow_conflict')::boolean,false);
  collision boolean; old_setting text:=coalesce(current_setting('app.coordinator_planning',true),''); result uuid; leg record;
begin
  if not public.is_approved() then raise exception 'not_authorized'; end if;
  if wants_planning and not public.can_manage_week(v_dept,v_week) then raise exception 'not_authorized'; end if;
  perform public.assert_same_day_window(v_start,v_end);
  if not(public.week_range(v_week) @> tstzrange(v_start,v_end,'[)')) then raise exception 'ride_outside_week'; end if;
  if v_id is not null then
    select * into existing from public.rides where id=v_id for update;
    if not found or existing.status='cancelled' then raise exception 'ride_not_found'; end if;
    if existing.department_id<>v_dept or existing.week_start<>v_week then raise exception 'not_authorized'; end if;
    if p_expected_version is null or existing.version<>p_expected_version then perform public.raise_stale_version(); end if;
  end if;
  perform pg_advisory_xact_lock(hashtextextended(v_car::text,0));
  select exists(select 1 from public.rides r where r.car_id=v_car and r.id is distinct from v_id and r.status<>'cancelled'
    and tstzrange(r.starts_at,r.ends_at,'[)') && tstzrange(v_start,v_end,'[)')) into collision;
  if wants_planning and collision and existing.id is not null and existing.status<>'draft' then
    if exists(select 1 from public.weeks where department_id=v_dept and week_start=v_week and phase='archived') then raise exception 'week_archived'; end if;
    if not exists(select 1 from public.cars where id=v_car and department_id=v_dept and status='active'
      and (type='shared' or owner_id=existing.driver_id)) then raise exception 'car_unavailable'; end if;
    if (v_start at time zone 'Asia/Jerusalem')::date<>(existing.starts_at at time zone 'Asia/Jerusalem')::date then raise exception 'ride_request_day_mismatch'; end if;
    if not public.is_quarter_hour(v_start) or not(public.is_quarter_hour(v_end) or public.is_same_day_end(v_end)) then raise exception 'invalid_ride_window'; end if;
    if exists(select 1 from public.car_maintenance_blocks b where b.car_id=v_car
      and tstzrange(b.starts_at,b.ends_at,'[)') && tstzrange(v_start,v_end,'[)')) then raise exception 'ride_conflicts_with_maintenance'; end if;
    -- Seat counts already include request owners. Add the volunteer only if not
    -- represented in this leg; never double count a driver/requester.
    for leg in select side,sum(q.adults)::int adults,sum(q.child_seats)::int children,sum(q.boosters)::int boosters,
      bool_or(q.requester_id=existing.driver_id) driver_included
      from public.ride_requests rr join public.requests q on q.id=rr.request_id
      cross join lateral(values('out'),('return')) legs(side)
      where rr.ride_id=v_id and ((side='out' and rr.covers_out) or (side='return' and rr.covers_return)) group by side loop
      if not public.car_fits(v_car,leg.adults+case when coalesce(leg.driver_included,false) then 0 else 1 end,leg.children,leg.boosters) then raise exception 'seat_config_violation'; end if;
    end loop;
    if exists(select 1 from public.ride_change_requests where ride_id=v_id and status='pending' and not is_planning) then raise exception 'ride_change_already_pending'; end if;
    update public.ride_change_requests set status='cancelled' where ride_id=v_id and status='pending' and is_planning;
    insert into public.ride_change_requests(department_id,week_start,requester_id,ride_id,car_id,starts_at,ends_at,expected_version,is_planning)
      values(v_dept,v_week,(select auth.uid()),v_id,v_car,v_start,v_end,existing.version,true);
    return v_id;
  end if;
  perform set_config('app.coordinator_planning',case when wants_planning then 'on' else '' end,true);
  result:=public.edit_ride_before_planning(p_ride,p_expected_version);
  perform set_config('app.coordinator_planning',old_setting,true);
  -- A successful placement resolves its saved private shadow, if any.
  update public.ride_change_requests set status='cancelled' where ride_id=result and status='pending' and is_planning;
  return result;
end $$;


ALTER FUNCTION public."edit_ride_before_series"("p_ride" "jsonb", "p_expected_version" integer) OWNER TO "postgres";


create or replace function public."eligible_leg_driver"("p_request_id" "uuid") RETURNS "uuid"
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
  select coalesce(
    (select q.requester_id from public.requests q join public.profiles p on p.id = q.requester_id
     where q.id = p_request_id and not p.does_not_drive),
    (select rc.profile_id from public.request_companions rc join public.profiles p on p.id = rc.profile_id
     where rc.request_id = p_request_id and not p.does_not_drive
     order by rc.profile_id limit 1)
  );
$$;

