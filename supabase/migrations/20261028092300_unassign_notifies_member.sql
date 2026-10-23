-- R14B1 (QA run 14): a Sadran taking a member off a ride through edit_ride (the served list no longer holds them)
-- told them nothing. Full definition from schema-current.sql; the only change is the notice loop where the
-- request goes back to the waiting list.
CREATE OR REPLACE FUNCTION "public"."edit_ride_before_planning"("p_ride" "jsonb", "p_expected_version" integer DEFAULT NULL::integer) RETURNS "uuid"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
declare
  v_prev_reason text;
  v_left record;
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
  -- REQ §13.129 (a): a private car's owner moving someone's ride onto that car.
  v_owner_move boolean := false;
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
    v_owner_move := v_id is not null and (p_ride->>'car_id')::uuid is distinct from v_existing.car_id
      and exists (select 1 from public.cars c where c.id = (p_ride->>'car_id')::uuid and c.type = 'temporary' and c.owner_id = (select auth.uid()));
    -- REQ §13.127: the driver, or anyone related to the ride (who filed it, a passenger, the private car's owner);
    -- REQ §13.129 (a): or the owner of the private car the ride moves onto.
    if v_id is null or not (v_existing.driver_id is not distinct from (select auth.uid()) or public.ride_related(v_id, (select auth.uid())) or v_owner_move)
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
      or exists (select 1 from public.ride_requests rr join public.requests q on q.id=rr.request_id where rr.ride_id=v_id and ((q.requester_id <> (select auth.uid()) and not public.request_related(q.id, (select auth.uid())) and not v_owner_move)
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
    -- R14B1: a member the Sadran takes off this ride (and who is on no other ride) is told, once: held on the board
    -- (REQ §13.138 c) so it nets against the ride they are put on next; sent at once off the board. Nobody is told
    -- about a request that already ended, nor about their own action.
    for v_left in
      with u as (
        update public.requests q set status='waitlisted',status_reason='SADRAN_UNASSIGNED'
        where q.id=any(v_old_requests) and q.status not in ('cancelled','withdrawn','denied','external')
          and not exists(select 1 from public.ride_requests rr join public.rides r on r.id=rr.ride_id where rr.request_id=q.id and r.status<>'cancelled')
        returning q.id, q.requester_id)
      select u.id, u.requester_id from u order by u.id
    loop
      if v_left.requester_id is distinct from (select auth.uid()) then
        perform public.enqueue_notification(v_left.requester_id,'outcome_changed',v_dept,v_week,
          jsonb_build_object('byName',coalesce((select full_name from public.profiles where id=(select auth.uid())),'')),
          jsonb_build_object('variant','unassigned_by_sadran','request_id',v_left.id,'ride_id',v_id),
          format('unassigned_by_sadran:%s:%s:%s',v_id,v_left.id,clock_timestamp()));
      end if;
    end loop;
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
  -- REQ §13.129 (a): the people of the ride are told their ride moved onto the owner's private car.
  if v_owner_move and public.is_day_public(v_dept, v_week, (v_existing.starts_at at time zone 'Asia/Jerusalem')::date) then
    perform public.enqueue_notification(x.pid, 'outcome_changed', v_dept, v_week,
      jsonb_build_object('changeLine', public._frag('change.car', jsonb_build_object(
        'newCar', coalesce((select name from public.cars where id = (p_ride->>'car_id')::uuid), ''),
        'oldCar', coalesce((select name from public.cars where id = v_existing.car_id), '')))),
      jsonb_build_object('variant', 'car_changed', 'request_id', x.rid, 'ride_id', v_id),
      format('owner_move:%s:%s:%s', v_id, x.pid, clock_timestamp()))
    from (select distinct q.requester_id as pid, q.id as rid from public.ride_requests rr join public.requests q on q.id = rr.request_id
          where rr.ride_id = v_id and q.requester_id is distinct from (select auth.uid())) x;
  end if;
  return v_id;
end $$;



-- R14B1: "הסר שיבוץ" on the board (unassign_ride) cancelled the ride and put the requests back on the waiting list
-- without a word. Now each affected member gets one `unassigned_by_sadran` notice (held on the board, REQ §13.138 c);
-- named passengers of a reservation get the ordinary `ride_cancelled` one. The notices are written BEFORE the ride is
-- cancelled so a person who was put on this ride and taken off again before sending nets to nothing
-- (rides_drop_held_joins removes the whole held group when the ride is cancelled).
create or replace function public.unassign_ride(p_ride_id uuid, p_expected_version integer)
 returns void
 language plpgsql
 security definer
 set search_path to 'public', 'pg_temp'
as $$
declare
  r public.rides%rowtype; ids uuid[];
  v_actor uuid := (select auth.uid());
  v_actor_name text; v_who record;
begin
  select * into r from public.rides where id=p_ride_id for update;
  if not found or r.status='cancelled' then raise exception 'ride_not_found'; end if;
  if not public.can_manage_week(r.department_id,r.week_start) then raise exception 'not_authorized'; end if;
  if p_expected_version is null or r.version<>p_expected_version then perform public.raise_stale_version(); end if;
  if exists(select 1 from public.weeks where department_id=r.department_id and week_start=r.week_start and phase='archived') then raise exception 'week_archived'; end if;
  perform set_config('app.audit_reason','unassign_ride',true);
  select array_agg(request_id) into ids from public.ride_requests where ride_id=r.id;
  select full_name into v_actor_name from public.profiles where id=v_actor;
  for v_who in
    select q.id as request_id, q.requester_id
    from public.ride_requests rr join public.requests q on q.id=rr.request_id
    where rr.ride_id=r.id and q.requester_id is distinct from v_actor
      and q.status not in ('cancelled','withdrawn','denied','external')
    order by q.id
  loop
    perform public.enqueue_notification(v_who.requester_id,'outcome_changed',r.department_id,r.week_start,
      jsonb_build_object('byName',coalesce(v_actor_name,'')),
      jsonb_build_object('variant','unassigned_by_sadran','request_id',v_who.request_id,'ride_id',r.id),
      format('unassigned_by_sadran:%s:%s:%s',r.id,v_who.request_id,clock_timestamp()));
  end loop;
  for v_who in
    select rp.person_id from public.ride_passengers rp
    where rp.ride_id=r.id and rp.person_id is not null and rp.person_id is distinct from v_actor
  loop
    perform public.enqueue_notification(v_who.person_id,'outcome_changed',r.department_id,r.week_start,
      jsonb_build_object('byName',coalesce(v_actor_name,'')),
      jsonb_build_object('variant','ride_cancelled','ride_id',r.id),
      format('ride_cancelled:%s:%s:%s',r.id,r.version,v_who.person_id));
  end loop;
  update public.rides set status='cancelled',cancelled_at=now(),cancelled_by=v_actor,cancel_reason='SADRAN_UNASSIGNED' where id=r.id;
  delete from public.ride_requests where ride_id=r.id;
  update public.requests q set status='waitlisted',status_reason='SADRAN_UNASSIGNED' where id=any(ids)
    and q.status not in ('cancelled','withdrawn','denied','external')   -- R7B9: a request that already ended stays ended
    and not exists(select 1 from public.ride_requests rr join public.rides rd on rd.id=rr.ride_id where rr.request_id=q.id and rd.status<>'cancelled');
  perform set_config('app.chain_hint', jsonb_build_object('origin_id',r.origin_id,'destination_id',r.destination_id,
    'starts_at',r.starts_at,'ends_at',r.ends_at)::text, true);
  perform public.assert_car_chain(r.car_id,r.week_start);
end $$;
