-- REQ §13.129 (owner 2026-10-12):
-- (a) a private car's owner may move ANY member's ride onto their car (form/ride sheet, siddur drag, board drag; the
--     client confirms first): `edit_ride_before_planning`'s member branch accepts a move onto the caller's own private
--     car; the ride's people are told the car changed. The owner acting is the consent (`rides_temp_car_owner_only`,
--     `assert_private_car_request`); later edits that keep the car and the driver need no new consent, and an edit's
--     re-placement on the car it was already on (`app.edit_prefer_car`) neither.
-- (b) a driver leaves their own ride and hands it to a named companion / added passenger who drives
--     (`hand_over_own_ride`): the request becomes that person's (as if filed for them — `filed_by` stays), the ride's
--     driver changes; else the driver cancels for everyone as before.
-- Functions only (full `create or replace`).

CREATE OR REPLACE FUNCTION "public"."rides_temp_car_owner_only"() RETURNS "trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
declare v_type public.car_type; v_owner uuid;
begin
  select type, owner_id into v_type, v_owner from public.cars where id = new.car_id;
  if v_type is distinct from 'temporary' or new.driver_id is not distinct from v_owner then return new; end if;
  -- consent was given when the ride got onto the car with this driver
  if tg_op = 'UPDATE' and old.car_id = new.car_id and old.driver_id is not distinct from new.driver_id then return new; end if;
  -- the owner is the one doing it (REQ §13.129 a), or an edit re-places a ride on the private car it was on
  if (select auth.uid()) is not distinct from v_owner
     or nullif(current_setting('app.edit_prefer_car', true), '') = new.car_id::text then return new; end if;
  -- someone the owner filed a live request for that day (REQ §13.127 c)
  if exists (
       select 1 from public.requests q
       where q.requester_id = new.driver_id and q.filed_by = v_owner and q.department_id = new.department_id
         and q.status not in ('withdrawn', 'cancelled')
         and (q.depart_at at time zone 'Asia/Jerusalem')::date = (new.starts_at at time zone 'Asia/Jerusalem')::date) then
    return new;
  end if;
  raise exception 'temporary_car_owner_only' using errcode = 'P0001';
end;
$$;

-- A private car takes a request when its owner is the actor, the requester or the one who filed it, or when an edit
-- re-places the request on the private car it was already on (REQ §13.129 a).
create or replace function public.assert_private_car_request(p_car uuid, p_actor uuid, p_request uuid) returns void
  language plpgsql stable security definer set search_path = public, pg_temp as $$
declare v_owner uuid;
begin
  select c.owner_id into v_owner from public.cars c where c.id = p_car and c.type = 'temporary';
  if v_owner is null or p_actor is not distinct from v_owner then return; end if;
  if exists (select 1 from public.requests q where q.id = p_request and (q.requester_id = v_owner or q.filed_by = v_owner)) then return; end if;
  if nullif(current_setting('app.edit_prefer_car', true), '') = p_car::text then return; end if;
  raise exception 'private_car_owner_only' using errcode = 'P0001';
end $$;

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


-- REQ §13.129 (b): the driver leaves their own ride and hands it to someone on it who drives — a companion named on the
-- driver's request, or a passenger added to the ride. The request becomes that person's, as if the driver had filed
-- it for them (`filed_by` stays, so the leaver still sees and may edit it); the ride's driver changes; the new driver
-- and the others on the ride are told (the "driver assigned / changed" notices). Only a ride that serves the driver's
-- own request(s) and nothing else, and not a multi-day series (those still cancel for everyone, or go to the Sadran).
create or replace function public.hand_over_own_ride(p_ride_id uuid, p_expected_version integer, p_new_driver uuid) returns jsonb
  language plpgsql security definer set search_path = public, pg_temp as $$
declare
  r public.rides%rowtype;
  v_actor uuid := (select auth.uid());
  v_req uuid;
  v_was_companion boolean;
  v_by text; v_driver_name text; v_route text; v_day text; v_car text;
  p record;
begin
  if not public.is_approved() then raise exception 'not_authorized' using errcode = 'P0001'; end if;
  select * into r from public.rides where id = p_ride_id for update;
  if not found or r.status = 'cancelled' then raise exception 'ride_not_found' using errcode = 'P0001'; end if;
  if p_expected_version is null or r.version <> p_expected_version then perform public.raise_stale_version(); end if;
  if r.driver_id is distinct from v_actor then raise exception 'not_authorized' using errcode = 'P0001'; end if;
  if exists (select 1 from public.weeks w where w.department_id = r.department_id and w.week_start = r.week_start and w.phase = 'archived') then
    raise exception 'week_archived' using errcode = 'P0001';
  end if;
  if (r.starts_at at time zone 'Asia/Jerusalem')::date < (now() at time zone 'Asia/Jerusalem')::date then
    raise exception 'ride_in_past' using errcode = 'P0001';
  end if;
  if r.series_id is not null
     or not exists (select 1 from public.ride_requests rr where rr.ride_id = r.id)
     or exists (select 1 from public.ride_requests rr join public.requests q on q.id = rr.request_id
                where rr.ride_id = r.id and (q.requester_id is distinct from v_actor or q.series_id is not null))
     -- the request is not held by another live ride too (a הקפצה's other leg)
     or exists (select 1 from public.ride_requests rr join public.ride_requests rr2 on rr2.request_id = rr.request_id and rr2.ride_id <> rr.ride_id
                join public.rides o on o.id = rr2.ride_id
                where rr.ride_id = r.id and o.status <> 'cancelled') then
    raise exception 'handover_not_possible' using errcode = 'P0001';
  end if;
  if p_new_driver is null or p_new_driver = v_actor
     or not exists (select 1 from public.profiles pr where pr.id = p_new_driver and pr.approval_status = 'approved' and not pr.does_not_drive)
     or not exists (select 1 from public.department_members dm where dm.department_id = r.department_id and dm.profile_id = p_new_driver and dm.removed_at is null)
     or not (exists (select 1 from public.ride_requests rr join public.request_companions rc on rc.request_id = rr.request_id
                     where rr.ride_id = r.id and rc.profile_id = p_new_driver)
             or exists (select 1 from public.ride_passengers rp where rp.ride_id = r.id and rp.person_id = p_new_driver)) then
    raise exception 'handover_driver_invalid' using errcode = 'P0001';
  end if;

  perform set_config('app.audit_reason', 'hand_over_own_ride', true);
  for v_req in select rr.request_id from public.ride_requests rr where rr.ride_id = r.id order by rr.request_id loop
    delete from public.request_companions where request_id = v_req and profile_id = p_new_driver;
    v_was_companion := found;
    -- the leaver's seat goes; a companion was already counted, an added passenger moves into the request
    update public.requests set requester_id = p_new_driver,
      adults = case when v_was_companion then greatest(adults - 1, 1) else adults end
    where id = v_req;
  end loop;
  delete from public.ride_passengers where ride_id = r.id and person_id = p_new_driver;
  update public.rides set driver_id = p_new_driver where id = r.id;
  perform public.assert_ride_driver(r.id);
  perform public.assert_ride_seats_fit(r.id);

  if public.is_day_public(r.department_id, r.week_start, (r.starts_at at time zone 'Asia/Jerusalem')::date) then
    select full_name into v_by from public.profiles where id = v_actor;
    select full_name into v_driver_name from public.profiles where id = p_new_driver;
    select name into v_car from public.cars where id = r.car_id;
    v_route := coalesce(public.request_route_label((select rr.request_id from public.ride_requests rr where rr.ride_id = r.id order by rr.request_id limit 1)), '');
    v_day := public.day_date_label(r.starts_at);
    perform public.enqueue_notification(p_new_driver, 'outcome_changed', r.department_id, r.week_start,
      jsonb_build_object('byName', coalesce(v_by, ''), 'route', v_route, 'day', v_day,
        'depart', to_char(r.starts_at at time zone 'Asia/Jerusalem', 'HH24:MI'), 'return', to_char(r.ends_at at time zone 'Asia/Jerusalem', 'HH24:MI'),
        'car', coalesce(v_car, '')),
      jsonb_build_object('variant', 'driver_assigned', 'ride_id', r.id),
      format('driver_assigned:%s:%s:%s', r.id, r.version, p_new_driver));
    for p in
      select rc.profile_id as pid from public.ride_requests rr join public.request_companions rc on rc.request_id = rr.request_id where rr.ride_id = r.id
      union select rp.person_id from public.ride_passengers rp where rp.ride_id = r.id and rp.person_id is not null
    loop
      continue when p.pid = p_new_driver or p.pid = v_actor;
      perform public.enqueue_notification(p.pid, 'outcome_changed', r.department_id, r.week_start,
        jsonb_build_object('driverName', coalesce(v_driver_name, ''), 'route', v_route, 'day', v_day, 'car', coalesce(v_car, '')),
        jsonb_build_object('variant', 'driver_changed_passenger', 'ride_id', r.id),
        format('driver_handover_passenger:%s:%s:%s', r.id, r.version, p.pid));
    end loop;
  end if;
  return jsonb_build_object('ride_id', r.id, 'driver_id', p_new_driver);
end $$;

revoke all on function public.hand_over_own_ride(uuid, integer, uuid) from public, anon;
grant execute on function public.hand_over_own_ride(uuid, integer, uuid) to authenticated;
