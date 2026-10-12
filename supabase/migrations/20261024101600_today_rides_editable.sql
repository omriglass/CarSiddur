-- REQ §13.128 (a): a ride stays editable from the ride sheet until its day is over (Asia/Jerusalem date), not only until
-- it starts — a late return or a surprise passenger is recorded the same day. Member ride moves/resizes
-- (`edit_ride_before_planning`), the collision consent path (`request_ride_change`) and the public notes
-- (`update_ride_public_notes`). The request form keeps its old limit (a known gap, docs/TODO.md).
-- Functions only (full `create or replace`).

CREATE OR REPLACE FUNCTION "public"."edit_ride_before_planning"("p_ride" "jsonb", "p_expected_version" integer DEFAULT NULL::integer) RETURNS "uuid"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
declare
  v_prev_reason text;
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
    -- REQ §13.127: the driver, or anyone related to the ride (who filed it, a passenger, the private car's owner).
    if v_id is null or not (v_existing.driver_id is not distinct from (select auth.uid()) or public.ride_related(v_id, (select auth.uid())))
       or not public.is_week_public(v_dept,v_week) then raise exception 'not_authorized'; end if;
    -- REQ §13.128 (a): editable until the ride's day is over (the day itself is fixed below), not only until it starts.
    if (v_existing.starts_at at time zone 'Asia/Jerusalem')::date < (now() at time zone 'Asia/Jerusalem')::date then
      raise exception 'ride_in_past';
    end if;
    if (p_ride ? 'driver_id' and (p_ride->>'driver_id')::uuid is distinct from v_existing.driver_id)
      or (p_ride ? 'origin_id' and (p_ride->>'origin_id')::uuid is distinct from v_existing.origin_id)
      or (p_ride ? 'destination_id' and (p_ride->>'destination_id')::uuid is distinct from v_existing.destination_id)
      or ((p_ride->>'starts_at')::timestamptz at time zone 'Asia/Jerusalem')::date <> (v_existing.starts_at at time zone 'Asia/Jerusalem')::date
      -- REQ §13.127: every request on the ride must be one the mover is related to (the requester's own, one they filed, …).
      or exists (select 1 from public.ride_requests rr join public.requests q on q.id=rr.request_id where rr.ride_id=v_id and ((q.requester_id <> (select auth.uid()) and not public.request_related(q.id, (select auth.uid())))
        -- Owner 2026-10-11: my own one-way (הלוך בלבד, a relay leg) moves like a ride that keeps the car — never a הקפצה relay leg.
        or not (rr.car_mode = 'keep' or (rr.car_mode = 'relay' and q.trip_type = 'one_way'))))
      -- A one-way leaves THIS car at its destination: it never moves to another car.
      or ((p_ride->>'car_id')::uuid is distinct from v_existing.car_id and exists (select 1 from public.ride_requests rr
        where rr.ride_id=v_id and rr.car_mode = 'relay'))
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
      is_pinned=case when v_needs_driver then true when v_manage then coalesce((p_ride->>'is_pinned')::boolean,true) else true end,pin_reason=case
        -- R6B11: a moved chauffeur leg is not a manual placement (whatever pin reason the board echoes back), so
        -- connect_drop_off_legs applies its normal rule to it: connect only if a driver is on board and the wait is not needed elsewhere.
        when v_manage and v_existing.car_id is distinct from (p_ride->>'car_id')::uuid
          and exists(select 1 from public.ride_requests rr where rr.ride_id=v_id and rr.car_mode='chauffeur') then 'SADRAN_MOVED'
        else coalesce(p_ride->>'pin_reason',case when v_manage then 'SADRAN_EDIT' else 'MEMBER_EDIT' end) end
    where id=v_id;
  end if;
  if v_manage and p_ride ? 'served' then
    select array_agg(request_id) into v_old_requests from public.ride_requests where ride_id=v_id;
    delete from public.ride_requests where ride_id=v_id;
    for v_served in select * from jsonb_array_elements(p_ride->'served') loop
      if exists (select 1 from public.rides where id=v_id and driver_id is null and not needs_driver) then raise exception 'reservation_cannot_serve_requests'; end if;
      select status, requester_id, status_reason into v_prev_status, v_rq_requester, v_prev_reason from public.requests where id=(v_served->>'request_id')::uuid;
      insert into public.ride_requests(ride_id,request_id,role,leg,car_mode,detour_minutes)
      values(v_id,(v_served->>'request_id')::uuid,(v_served->>'role')::public.ride_role,
        coalesce((v_served->>'leg')::public.ride_leg,'both'),(v_served->>'car_mode')::public.leg_car_mode,coalesce((v_served->>'detour_minutes')::smallint,0));
      update public.requests set status=case when v_needs_driver then 'waitlisted'::public.request_status when v_served->>'role'='driver' then 'assigned'::public.request_status else 'merged'::public.request_status end,status_reason=case when v_needs_driver then 'UNMET_NEEDS_DRIVER' else 'SADRAN_ASSIGNED' end
      where id=(v_served->>'request_id')::uuid;
      if v_manage and not v_needs_driver and v_prev_status in ('waitlisted','submitted','proposed')
         and v_rq_requester is distinct from (select auth.uid())
         -- R4B8: not when the request was already on this ride, or already placed and only awaiting a driver
         and not ((v_served->>'request_id')::uuid = any(coalesce(v_old_requests,'{}'::uuid[])))
         and v_prev_reason is distinct from 'UNMET_NEEDS_DRIVER'
         and public.is_day_public(v_dept,v_week,((p_ride->>'starts_at')::timestamptz at time zone 'Asia/Jerusalem')::date) then
        perform public.enqueue_notification(v_rq_requester,'outcome_changed',v_dept,v_week,'{}'::jsonb,
          jsonb_build_object('variant','placed_by_sadran','request_id',(v_served->>'request_id')::uuid,'ride_id',v_id),
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


CREATE OR REPLACE FUNCTION "public"."update_ride_public_notes"("p_ride_id" "uuid", "p_expected_version" integer, "p_notes" "text") RETURNS "void"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
declare
  ride_row public.rides%rowtype;
  week_phase public.week_phase;
  clean_notes text := nullif(btrim(p_notes), '');
begin
  if not public.is_approved() then raise exception 'not_authorized'; end if;
  select * into ride_row from public.rides where id = p_ride_id for update;
  if not found or ride_row.status = 'cancelled' then raise exception 'ride_not_found'; end if;

  if not public.can_manage_week(ride_row.department_id, ride_row.week_start) then
    if not public.member_of(ride_row.department_id)
      or not public.is_week_public(ride_row.department_id, ride_row.week_start)
      or not (
        ride_row.driver_id is not distinct from (select auth.uid())
        -- REQ §13.127: anyone related to the ride (who filed it, a passenger, the private car's owner).
        or public.ride_related(ride_row.id, (select auth.uid()))
        or exists (
          select 1 from public.ride_requests rr
          join public.requests q on q.id = rr.request_id
          where rr.ride_id = ride_row.id and q.requester_id = (select auth.uid())
        )
      )
    then raise exception 'not_authorized'; end if;
  end if;

  select phase into week_phase from public.weeks
  where department_id = ride_row.department_id and week_start = ride_row.week_start
  for share;
  if week_phase = 'archived' then raise exception 'week_archived'; end if;
  -- REQ §13.128 (a): until the end of the ride's day.
  if (ride_row.starts_at at time zone 'Asia/Jerusalem')::date < (now() at time zone 'Asia/Jerusalem')::date then raise exception 'ride_in_past'; end if;
  if p_expected_version is null or ride_row.version <> p_expected_version then
    perform public.raise_stale_version();
  end if;
  if char_length(clean_notes) > 1000
    or (clean_notes is null and ride_row.driver_id is null and not ride_row.needs_driver)
  then raise exception 'invalid_ride_description'; end if;

  -- Existing version, updated_at and audit triggers remain authoritative. No ride
  -- scheduling/status/driver fields, linked requests or consent rows are changed.
  if ride_row.notes is distinct from clean_notes then
    perform set_config('app.audit_reason', 'update_ride_public_notes', true);
    update public.rides set notes = clean_notes where id = ride_row.id;
  end if;
end;
$$;


CREATE OR REPLACE FUNCTION "public"."request_ride_change"("p_ride_id" "uuid", "p_car_id" "uuid", "p_starts_at" timestamp with time zone, "p_ends_at" timestamp with time zone, "p_expected_version" integer, "p_allow_small_trunk" boolean DEFAULT false) RETURNS "uuid"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
declare r public.rides%rowtype; other public.rides%rowtype; ch uuid; buffer interval; cnt int:=0;
begin
  select * into r from public.rides where id=p_ride_id for update;
  if not found then raise exception 'ride_not_found'; end if;
  if not public.is_approved() or r.driver_id is distinct from (select auth.uid()) or not public.is_week_public(r.department_id,r.week_start) then raise exception 'not_authorized'; end if;
  if r.status='cancelled' or r.version<>p_expected_version then perform public.raise_stale_version(); end if;
  -- REQ §13.128 (a): a ride of today may still change (the day itself must stay the same, below).
  if (r.starts_at at time zone 'Asia/Jerusalem')::date < (now() at time zone 'Asia/Jerusalem')::date or p_ends_at<=p_starts_at or (p_starts_at at time zone 'Asia/Jerusalem')::date<>(r.starts_at at time zone 'Asia/Jerusalem')::date then raise exception 'ride_request_day_mismatch'; end if;
  if not (public.week_range(r.week_start) @> tstzrange(p_starts_at,p_ends_at,'[)')) then raise exception 'ride_outside_week'; end if;
  if exists(select 1 from public.ride_requests rr join public.requests q on q.id=rr.request_id where rr.ride_id=r.id and (q.requester_id<>r.driver_id or rr.car_mode='relay')) then raise exception 'shared_ride_requires_sadran'; end if;
  -- REQ §13.111 (a): the driver may accept a car without a large trunk for their own large-luggage request(s); the
  -- waiver is stamped only when the change is accepted (respond_ride_change_before_planning).
  perform public._small_trunk_check(array(select rr.request_id from public.ride_requests rr where rr.ride_id=r.id), p_car_id, p_allow_small_trunk);
  perform 1 from public.cars where id=p_car_id and department_id=r.department_id and status='active' and type='shared' for update;
  if not found then raise exception 'car_unavailable'; end if;
  select make_interval(mins=>coalesce((w.settings_overrides->>'turnaround_minutes')::int,s.turnaround_minutes)) into buffer
  from public.department_settings s join public.weeks w on w.department_id=s.department_id where w.department_id=r.department_id and w.week_start=r.week_start;
  if exists(select 1 from public.car_maintenance_blocks where car_id=p_car_id and tstzrange(starts_at,ends_at,'[)') && tstzrange(p_starts_at,p_ends_at+buffer,'[)')) then raise exception 'ride_conflicts_with_maintenance'; end if;
  update public.ride_change_requests set status='cancelled' where ride_id=r.id and status='pending';
  insert into public.ride_change_requests(department_id,week_start,requester_id,ride_id,car_id,starts_at,ends_at,expected_version,allow_small_trunk)
  values(r.department_id,r.week_start,(select auth.uid()),r.id,p_car_id,p_starts_at,p_ends_at,r.version,coalesce(p_allow_small_trunk,false)) returning id into ch;
  for other in select * from public.rides where car_id=p_car_id and id<>r.id and status<>'cancelled'
    and tstzrange(starts_at,blocked_until,'[)') && tstzrange(p_starts_at,p_ends_at+buffer,'[)') order by id for update loop
    if other.driver_id is null or other.driver_id=r.driver_id or other.origin_id<>other.destination_id
      or exists(select 1 from public.ride_requests rr join public.requests q on q.id=rr.request_id where rr.ride_id=other.id and q.requester_id<>other.driver_id)
    then raise exception 'shared_ride_requires_sadran'; end if;
    insert into public.ride_change_parties(change_id,ride_id,profile_id,expected_version) values(ch,other.id,other.driver_id,other.version);
    perform public.enqueue_notification(other.driver_id,'proposal_received',r.department_id,r.week_start,
      jsonb_build_object('requesterName',(select full_name from public.profiles where id=r.driver_id),
        'date',to_char(p_starts_at at time zone 'Asia/Jerusalem','DD/MM/YY'),
        'depart',to_char(p_starts_at at time zone 'Asia/Jerusalem','HH24:MI'),'return',to_char(p_ends_at at time zone 'Asia/Jerusalem','HH24:MI')),
      jsonb_build_object('ride_change_id',ch,'ride_id',other.id,'url','/inbox?change='||ch),format('ride_change:%s:%s',ch,other.driver_id));
    cnt:=cnt+1;
  end loop;
  if cnt=0 then raise exception 'no_conflicting_ride'; end if;
  return ch;
end $$;
