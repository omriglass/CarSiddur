-- REQ item 227 (PC1): every "is this person the private car's owner?" check reads car_owners (is_car_owner()), not
-- cars.owner_id. Full definitions, each the current one from schema-current.sql with only the owner checks changed.
-- (c) An ownerless private car (its last owner left the department) is the Sadran's and the admins' to use.

-- A person (not necessarily the caller) who may use an ownerless private car: an admin or a Sadran of its department.
create or replace function public._may_use_ownerless_car(p_car uuid, p_person uuid)
returns boolean
language sql stable security definer
set search_path = public, pg_temp
as $$
  select p_person is not null and not public.car_has_owners(p_car) and (
    exists (select 1 from public.profiles p where p.id = p_person and p.is_admin)
    or exists (select 1 from public.cars c join public.sadran_assignments sa on sa.department_id = c.department_id
               where c.id = p_car and sa.profile_id = p_person));
$$;
revoke all on function public._may_use_ownerless_car(uuid, uuid) from public;


CREATE OR REPLACE FUNCTION public.assert_private_car_owner_only(p_car uuid, p_actor uuid, p_requester uuid)
 RETURNS void
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
begin
  if not exists (select 1 from public.cars c where c.id = p_car and c.type = 'temporary') then return; end if;
  if public.is_car_owner(p_car, p_actor) or public.is_car_owner(p_car, p_requester) then return; end if;
  if public._may_use_ownerless_car(p_car, p_actor) then return; end if;
  raise exception 'private_car_owner_only' using errcode = 'P0001';
end $function$;

CREATE OR REPLACE FUNCTION public.assert_private_car_request(p_car uuid, p_actor uuid, p_request uuid)
 RETURNS void
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
begin
  if not exists (select 1 from public.cars c where c.id = p_car and c.type = 'temporary') then return; end if;
  if public.is_car_owner(p_car, p_actor) or public._may_use_ownerless_car(p_car, p_actor) then return; end if;
  if exists (select 1 from public.requests q where q.id = p_request
             and (public.is_car_owner(p_car, q.requester_id) or public.is_car_owner(p_car, q.filed_by))) then return; end if;
  if nullif(current_setting('app.edit_prefer_car', true), '') = p_car::text then return; end if;
  raise exception 'private_car_owner_only' using errcode = 'P0001';
end $function$;

CREATE OR REPLACE FUNCTION public.ride_related(p_ride uuid, p_actor uuid)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  select p_actor is not null and exists (
    select 1 from public.rides r left join public.cars c on c.id = r.car_id
    where r.id = p_ride and (
      r.driver_id = p_actor
      or (c.type = 'temporary' and public.is_car_owner(c.id, p_actor))
      or exists (select 1 from public.ride_passengers rp where rp.ride_id = r.id and rp.person_id = p_actor)
      or exists (select 1 from public.ride_requests rr join public.requests q on q.id = rr.request_id
                 where rr.ride_id = r.id and (q.requester_id = p_actor or q.filed_by = p_actor
                   or exists (select 1 from public.request_companions rc where rc.request_id = q.id and rc.profile_id = p_actor)
                   or public._is_ride_editor(r.department_id, q.requester_id, p_actor)))
      -- REQ §13.202
      or public._is_ride_editor(r.department_id, r.driver_id, p_actor)));
$function$;

CREATE OR REPLACE FUNCTION public.rides_temp_car_owner_only()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare v_type public.car_type;
begin
  select type into v_type from public.cars where id = new.car_id;
  if v_type is distinct from 'temporary' or public.is_car_owner(new.car_id, new.driver_id) then return new; end if;
  -- consent was given when the ride got onto the car with this driver
  if tg_op = 'UPDATE' and old.car_id = new.car_id and old.driver_id is not distinct from new.driver_id then return new; end if;
  -- an owner is the one doing it (REQ §13.129 a), or an edit re-places a ride on the private car it was on
  if public.is_car_owner(new.car_id, (select auth.uid()))
     or nullif(current_setting('app.edit_prefer_car', true), '') = new.car_id::text then return new; end if;
  -- REQ item 227 (c): an ownerless private car is the Sadran's / an admin's to use
  if public._may_use_ownerless_car(new.car_id, (select auth.uid())) then return new; end if;
  -- someone an owner filed a live request for that day (REQ §13.127 c)
  if exists (
       select 1 from public.requests q
       where q.requester_id = new.driver_id and public.is_car_owner(new.car_id, q.filed_by) and q.department_id = new.department_id
         and q.status not in ('withdrawn', 'cancelled')
         and (q.depart_at at time zone 'Asia/Jerusalem')::date = (new.starts_at at time zone 'Asia/Jerusalem')::date) then
    return new;
  end if;
  raise exception 'temporary_car_owner_only' using errcode = 'P0001';
end;
$function$;

-- R19B13 / REQ item 227: an owner gives the car back to the fleet (p_owner_id null: shared, no owners — for every
-- owner) or hands their own place on to another approved member of the department (the other owners stay).
CREATE OR REPLACE FUNCTION public.set_own_private_car(p_car_id uuid, p_owner_id uuid DEFAULT NULL::uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  v_car public.cars%rowtype;
  v_me uuid := (select auth.uid());
begin
  select * into v_car from public.cars where id = p_car_id for update;
  if v_car.id is null or v_car.type <> 'temporary' or not public.is_car_owner(p_car_id, v_me) then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  if p_owner_id is not null and not exists (
      select 1 from public.department_members dm join public.profiles p on p.id = dm.profile_id
      where dm.department_id = v_car.department_id and dm.profile_id = p_owner_id and dm.removed_at is null
        and p.approval_status = 'approved') then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  if p_owner_id is null then
    -- the field guard lets only this function's own change through
    perform set_config('app.own_private_car', p_car_id::text, true);
    update public.cars set type = 'shared', owner_id = null where id = p_car_id;   -- cars_sync_owners clears the list
    perform set_config('app.own_private_car', '', true);
  elsif p_owner_id is distinct from v_me then
    insert into public.car_owners (car_id, profile_id, department_id, added_by)
    values (p_car_id, p_owner_id, v_car.department_id, v_me)
    on conflict (car_id, profile_id) do nothing;
    delete from public.car_owners where car_id = p_car_id and profile_id = v_me;
  end if;
end $function$;

CREATE OR REPLACE FUNCTION public.validate_preferred_car()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare v_filed_by uuid := case when tg_table_name = 'requests' then (to_jsonb(new) ->> 'filed_by')::uuid end;
begin
  if new.preferred_car_id is null then return new; end if;
  if not exists(select 1 from public.cars c where c.id=new.preferred_car_id and c.department_id=new.department_id
      and (c.type='shared' or (c.type='temporary' and (public.is_car_owner(c.id, new.requester_id) or public.is_car_owner(c.id, v_filed_by))))) then
    raise exception 'invalid_preferred_car';
  end if;
  if (tg_op='INSERT' or new.preferred_car_id is distinct from old.preferred_car_id)
    and not exists(select 1 from public.cars c where c.id=new.preferred_car_id and c.status='active') then
    raise exception 'invalid_preferred_car';
  end if;
  return new;
end $function$;

CREATE OR REPLACE FUNCTION public.cars_protect_owner_editable_fields()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
begin
  if nullif(current_setting('app.own_private_car', true), '') = old.id::text
     and (to_jsonb(new) - 'type' - 'owner_id' - 'updated_at') is not distinct from (to_jsonb(old) - 'type' - 'owner_id' - 'updated_at') then
    return new;
  end if;
  if not (
    public.is_admin()
    or public.is_car_responsible(old.id)
    or (public.can_manage_operations(old.department_id)
        and (new.department_id is not distinct from old.department_id
             or public.can_manage_operations(new.department_id)))
  ) then
    if public.is_car_admin(old.department_id) and not public.is_car_owner(old.id, (select auth.uid())) then
      -- Acting as a car administrator only.
      if new.department_id is distinct from old.department_id then
        raise exception 'car_fields_locked' using errcode = 'P0001';
      end if;
      if old.type = 'temporary'
         and (to_jsonb(new) - 'status' - 'retired_at' - 'updated_at')
             is distinct from (to_jsonb(old) - 'status' - 'retired_at' - 'updated_at') then
        raise exception 'car_fields_locked' using errcode = 'P0001';
      end if;
      return new;
    end if;
    if new.name is distinct from old.name
       or new.license_plate is distinct from old.license_plate
       or new.department_id is distinct from old.department_id
       or new.type is distinct from old.type
       or new.owner_id is distinct from old.owner_id
       or new.built_in_child_seats is distinct from old.built_in_child_seats
       or new.built_in_boosters is distinct from old.built_in_boosters
    then
      raise exception 'car_fields_locked' using errcode = 'P0001';
    end if;
  end if;
  return new;
end;
$function$;

CREATE OR REPLACE FUNCTION public._day_car_swap_private_car_blockers(p_car_a uuid, p_car_b uuid, p_actor uuid)
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  select coalesce(jsonb_agg(jsonb_build_object('code', 'private_car', 'car_id', c.id,
      'detail', format('car %s is a private car; only its owners may swap it', c.id))), '[]'::jsonb)
  from public.cars c
  where c.id in (p_car_a, p_car_b) and c.type = 'temporary' and not public.is_car_owner(c.id, p_actor)
    and not public._may_use_ownerless_car(c.id, p_actor);
$function$;

CREATE OR REPLACE FUNCTION public.edit_ride_before_planning(p_ride jsonb, p_expected_version integer DEFAULT NULL::integer)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
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
  -- REQ §13.179 (b): the other people's own parts before a member's move
  v_spans jsonb := '{}'::jsonb; v_person record; v_span tstzrange;
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
      and exists (select 1 from public.cars c where c.id = (p_ride->>'car_id')::uuid and c.type = 'temporary' and public.is_car_owner(c.id, (select auth.uid())));
    -- REQ §13.127: the driver, or anyone related to the ride (who filed it, a passenger, the private car's owner);
    -- REQ §13.129 (a): or the owner of the private car the ride moves onto.
    -- REQ §13.205 (b): with the department's "anyone edits rides" switch on (REQ §13.169), a member related to its requests
    -- (request_related: every approved member then) moves and resizes it like their own.
    if v_id is null or not (v_existing.driver_id is not distinct from (select auth.uid()) or public.ride_related(v_id, (select auth.uid())) or v_owner_move
         or (exists (select 1 from public.department_settings s where s.department_id = v_dept and s.anyone_edits_rides)
             and exists (select 1 from public.ride_requests rr where rr.ride_id = v_id and public.request_related(rr.request_id, (select auth.uid())))))
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
        or not (rr.car_mode = 'keep' or (rr.car_mode = 'relay' and q.trip_type = 'one_way')
          -- REQ §13.179 (a): someone riding along (a merge) never stops the people on the ride from moving it
          or (rr.role = 'passenger' and rr.car_mode = 'passenger')
          -- REQ §13.181 (a): a הקפצה leg (chauffeur ride) moves too - its rider, or anyone on it, may move it
          or (rr.role = 'passenger' and rr.car_mode = 'chauffeur'))))
      -- A one-way leaves THIS car at its destination: it never moves to another car.
      or ((p_ride->>'car_id')::uuid is distinct from v_existing.car_id and exists (select 1 from public.ride_requests rr
        where rr.ride_id=v_id and rr.car_mode = 'relay'))
    then raise exception 'not_authorized'; end if;
  end if;
  if not exists (select 1 from public.cars where id=(p_ride->>'car_id')::uuid and status='active' and department_id=v_dept) then raise exception 'car_unavailable'; end if;
  -- REQ §13.99: only the owner puts requests on a private (temporary) car.
  select * into v_car_row from public.cars where id=(p_ride->>'car_id')::uuid;
  if v_car_row.type='temporary' and not public.is_car_owner(v_car_row.id, (select auth.uid()))
     and not public._may_use_ownerless_car(v_car_row.id, (select auth.uid())) then
    if v_id is not null and v_existing.car_id is distinct from v_car_row.id then
      raise exception 'private_car_owner_only' using errcode='P0001';  -- moving a ride onto it
    elsif v_id is null and (jsonb_array_length(coalesce(p_ride->'served','[]'))=0 or exists(
        select 1 from jsonb_array_elements(p_ride->'served') s join public.requests q on q.id=(s->>'request_id')::uuid
        where not public.is_car_owner(v_car_row.id, q.requester_id))) then
      raise exception 'private_car_owner_only' using errcode='P0001';  -- a new ride that is not the owner's own
    elsif v_id is not null and v_manage and p_ride ? 'served' and exists(
        select 1 from jsonb_array_elements(p_ride->'served') s join public.requests q on q.id=(s->>'request_id')::uuid
        where not public.is_car_owner(v_car_row.id, q.requester_id)
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
  -- REQ §13.181 (a): a member's move keeps a driverless הקפצה driverless (it never turns into a reservation)
  v_needs_driver:=case when v_manage then coalesce((p_ride->>'needs_driver')::boolean,v_existing.needs_driver,false) else coalesce(v_existing.needs_driver,false) end;
  if not v_manage and v_id is not null then
    for v_person in select x.pid from public._ride_person_ids(v_id) x where x.pid is distinct from (select auth.uid()) order by x.pid loop
      v_span := public.person_ride_span(v_id, v_person.pid);
      if v_span is not null then
        v_spans := v_spans || jsonb_build_object(v_person.pid::text, jsonb_build_array(lower(v_span), upper(v_span)));
      end if;
    end loop;
  end if;
  perform set_config('app.audit_reason','edit_ride',true);
  if v_manage then
    v_override:=public.prepare_manual_ride_window((p_ride->>'car_id')::uuid,v_week,(p_ride->>'starts_at')::timestamptz,(p_ride->>'ends_at')::timestamptz,v_id);
  elsif v_id is not null and coalesce(current_setting('app.short_turnaround',true),'')='allow' then
    -- REQ §13.190: a member may end less than the turnaround before the car's next ride (after "תיאמתם עם X…?"),
    -- never start inside the turnaround of the ride before; the next ride's driver (else first rider) is told.
    if exists(select 1 from public.rides r where r.car_id=(p_ride->>'car_id')::uuid and r.id<>v_id and r.status<>'cancelled' and not r.draft_hold
        and r.ends_at<=(p_ride->>'starts_at')::timestamptz and r.blocked_until>(p_ride->>'starts_at')::timestamptz) then
      raise exception 'ride_time_overlap' using errcode='23P01';
    end if;
    v_override:=public.prepare_manual_ride_window((p_ride->>'car_id')::uuid,v_week,(p_ride->>'starts_at')::timestamptz,(p_ride->>'ends_at')::timestamptz,v_id);
    perform public._notify_short_turnaround((p_ride->>'car_id')::uuid,(p_ride->>'ends_at')::timestamptz,v_id,(select auth.uid()));
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
  if v_spans <> '{}'::jsonb then
    perform public._ride_moved_by_member(v_id, v_spans, coalesce((p_ride->>'agreed')::boolean, false));
  end if;
  return v_id;
end $function$;

CREATE OR REPLACE FUNCTION public.edit_ride_before_series(p_ride jsonb, p_expected_version integer DEFAULT NULL::integer)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
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
  select exists(select 1 from public.rides r where r.car_id=v_car and r.id is distinct from v_id and r.status<>'cancelled' and not r.draft_hold
    and tstzrange(r.starts_at,r.ends_at,'[)') && tstzrange(v_start,v_end,'[)')) into collision;
  if wants_planning and collision and existing.id is not null and existing.status<>'draft' then
    if exists(select 1 from public.weeks where department_id=v_dept and week_start=v_week and phase='archived') then raise exception 'week_archived'; end if;
    if not exists(select 1 from public.cars where id=v_car and department_id=v_dept and status='active'
      and (type='shared' or public.is_car_owner(id, existing.driver_id))) then raise exception 'car_unavailable'; end if;
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
end $function$;

CREATE OR REPLACE FUNCTION public.place_waiting_request(p_request_id uuid, p_car_id uuid, p_depart_at timestamp with time zone, p_return_at timestamp with time zone, p_expected_version integer, p_accept text[] DEFAULT '{}'::text[])
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  q public.requests%rowtype; v_car public.cars%rowtype; v_uid uuid := (select auth.uid());
  v_home uuid; v_origin uuid; v_car_at uuid; v_start uuid; v_next uuid; v_buffer int;
  v_prev_end timestamptz; v_next_start timestamptz; v_day date; v_phase public.week_phase;
  v_warnings jsonb := '[]'::jsonb; v_ride uuid; v_prev_transition text; v_prev_trunk text;
  v_accept text[] := coalesce(p_accept, '{}'); v_moved boolean := false;
begin
  select * into q from public.requests where id = p_request_id for update;
  select * into v_car from public.cars where id = p_car_id and department_id = q.department_id and status = 'active';
  if q.id is null or not (public.can_edit_request(q.id)
       or (v_car.type = 'temporary' and public.is_car_owner(v_car.id, v_uid) and public.member_of(q.department_id))) then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  if q.version <> p_expected_version then raise exception 'stale_version' using errcode = 'P0409'; end if;
  if q.status <> 'waitlisted' or q.trip_type <> 'round_trip' or q.series_id is not null then
    return jsonb_build_object('ok', false, 'blocked', 'not_draggable');
  end if;
  if p_depart_at is null or p_return_at is null or p_return_at <= p_depart_at
     or (p_depart_at at time zone 'Asia/Jerusalem')::date <> (p_return_at at time zone 'Asia/Jerusalem')::date then
    raise exception 'invalid_ride_window' using errcode = 'P0001';
  end if;
  v_day := (p_depart_at at time zone 'Asia/Jerusalem')::date;
  select phase into v_phase from public.weeks where department_id = q.department_id and week_start = q.week_start;
  if v_phase not in ('published', 'live') or not public.is_day_public(q.department_id, q.week_start, v_day)
     or v_day <> ((coalesce(q.depart_at, q.return_at)) at time zone 'Asia/Jerusalem')::date then
    return jsonb_build_object('ok', false, 'blocked', 'not_draggable');
  end if;
  if p_depart_at < now() then return jsonb_build_object('ok', false, 'blocked', 'past'); end if;
  if exists (select 1 from public.ride_requests rr join public.rides r on r.id = rr.ride_id
             where rr.request_id = q.id and r.status <> 'cancelled')
     or exists (select 1 from public.waitlist_group_members gm join public.waitlist_groups g on g.id = gm.group_id
                where gm.request_id = q.id and g.status = 'open') then
    return jsonb_build_object('ok', false, 'blocked', 'not_draggable');
  end if;

  if v_car.id is null then raise exception 'shift_car_invalid' using errcode = 'P0001'; end if;
  perform pg_advisory_xact_lock(hashtextextended(v_car.id::text, 0));

  -- Refusals: nothing a member may take from someone else.
  -- Only the owner puts a request on their private car (REQ §13.99).
  if v_car.type = 'temporary' and not public.is_car_owner(v_car.id, v_uid) and not public._may_use_ownerless_car(v_car.id, v_uid) then
    return jsonb_build_object('ok', false, 'blocked', 'private_car');
  end if;
  if exists (select 1 from public.rides r where r.car_id = v_car.id and r.status <> 'cancelled' and not r.draft_hold
             and tstzrange(r.starts_at, r.ends_at, '[)') && tstzrange(p_depart_at, p_return_at, '[)')) then
    return jsonb_build_object('ok', false, 'blocked', 'overlap');
  end if;
  if exists (select 1 from public.car_maintenance_blocks m where m.car_id = v_car.id
             and tstzrange(m.starts_at, m.ends_at, '[)') && tstzrange(p_depart_at, p_return_at, '[)')) then
    return jsonb_build_object('ok', false, 'blocked', 'maintenance');
  end if;
  if not public.car_fits(v_car.id, q.adults, q.child_seats, q.boosters) then
    return jsonb_build_object('ok', false, 'blocked', 'seats');
  end if;
  if public.car_held_by_waitlist_group(v_car.id, p_depart_at, p_return_at, q.id) then
    return jsonb_build_object('ok', false, 'blocked', 'held');
  end if;
  if exists (select 1 from public.freed_slot_offers o where o.car_id = v_car.id and o.status = 'open'
             and o.expires_at > now() and tstzrange(o.starts_at, o.ends_at, '[)') && tstzrange(p_depart_at, p_return_at, '[)')) then
    return jsonb_build_object('ok', false, 'blocked', 'offered');
  end if;
  if public.eligible_leg_driver(q.id) is null then
    return jsonb_build_object('ok', false, 'blocked', 'no_driver');
  end if;

  -- Where the ride starts: the request's place, or — once the member accepts it — where the car stands.
  select home_destination_id into v_home from public.departments where id = q.department_id;
  v_origin := case when q.origin_id is null and nullif(q.origin_text, '') is not null then null else coalesce(q.origin_id, v_home) end;
  v_car_at := coalesce(public.car_location_at(v_car.id, p_depart_at), v_home);
  v_start := coalesce(v_origin, v_home);
  -- A shared car is taken where it stands (a free-text start place never matches it); a private car goes with its owner.
  if v_car.type = 'shared' and (v_origin is null or v_car_at <> v_origin) then
    if 'location' = any(v_accept) then v_start := v_car_at; v_moved := true;
    else v_warnings := v_warnings || jsonb_build_object('code', 'location',
           'place', (select name from public.destinations where id = v_car_at));
    end if;
  end if;
  v_next := public.car_next_ride_origin(v_car.id, p_return_at);
  if v_next is not null and v_next <> v_start then
    return jsonb_build_object('ok', false, 'blocked', 'next_elsewhere');
  end if;

  -- Warnings that concern the member only.
  v_buffer := coalesce(public.required_turnaround_minutes(q.department_id, q.week_start), 30);
  select max(r.ends_at) into v_prev_end from public.rides r
    where r.car_id = v_car.id and r.status <> 'cancelled' and not r.draft_hold and r.ends_at <= p_depart_at;
  select min(r.starts_at) into v_next_start from public.rides r
    where r.car_id = v_car.id and r.status <> 'cancelled' and not r.draft_hold and r.starts_at >= p_return_at;
  if (v_prev_end is not null and v_prev_end + make_interval(mins => v_buffer) > p_depart_at)
     or (v_next_start is not null and p_return_at + make_interval(mins => v_buffer) > v_next_start) then
    if not 'turnaround' = any(v_accept) then
      v_warnings := v_warnings || jsonb_build_object('code', 'turnaround', 'minutes', v_buffer);
    end if;
  end if;
  -- REQ §13.200: the same warning (and the same accept key) covers a towing request on a car without a hitch
  if q.luggage_waived_at is null
     and not public.car_meets_needs(v_car.id, case when q.has_luggage then 1 else 0 end, case when q.needs_tow_hitch then 1 else 0 end)
     and not 'luggage' = any(v_accept) then
    v_warnings := v_warnings || jsonb_build_object('code', 'luggage', 'needs', to_jsonb(array_remove(array[
      case when q.has_luggage and not public.car_takes_luggage(v_car.id, 1) then 'large_trunk' end,
      case when q.needs_tow_hitch and not exists (select 1 from public.cars hc where hc.id = v_car.id and 'tow_hitch' = any(hc.features)) then 'tow_hitch' end], null)));
  end if;
  if jsonb_array_length(v_warnings) > 0 then
    return jsonb_build_object('ok', false, 'warnings', v_warnings);
  end if;

  -- Place it: the new hours and start place, then the same placement the Sadran's manual drop uses.
  v_prev_transition := current_setting('app.system_status_transition', true);
  v_prev_trunk := current_setting('app.small_trunk', true);
  perform set_config('app.system_status_transition', 'on', true);
  if 'luggage' = any(v_accept) then perform set_config('app.small_trunk', 'allow', true); end if;
  update public.requests set depart_at = p_depart_at, return_at = p_return_at, preferred_car_id = case when v_car.type = 'shared' then v_car.id else preferred_car_id end,
         origin_id = case when v_moved then v_start else origin_id end,
         origin_text = case when v_moved then null else origin_text end,
         changed_since_solve = true
   where id = q.id;
  v_ride := public.place_request_on_car(q.id, v_car.id, true, v_uid, null, p_depart_at, p_return_at, 'MEMBER_PLACED');
  perform set_config('app.small_trunk', coalesce(v_prev_trunk, ''), true);
  perform set_config('app.system_status_transition', coalesce(v_prev_transition, 'off'), true);

  perform public.enqueue_notification(s.profile_id, 'request_changed', q.department_id, q.week_start,
    jsonb_build_object('requestId', q.id::text), jsonb_build_object('request_id', q.id),
    format('request_changed:%s:%s', q.id, now()))
  from public.sadranim_of(q.department_id, q.week_start) as s(profile_id)
  where s.profile_id is distinct from v_uid;

  -- The owner gave their car: the requester (and a filer) learn they drive it.
  perform public.enqueue_notification(x.recipient, 'outcome_changed', q.department_id, q.week_start,
    jsonb_build_object('byName', coalesce((select full_name from public.profiles where id = v_uid), ''),
      'route', coalesce(public.request_route_label(q.id), ''), 'day', public.day_date_label(p_depart_at),
      'timeRange', public._window_text(p_depart_at, p_return_at), 'car', v_car.name),
    jsonb_build_object('variant', 'owner_car_given', 'request_id', q.id, 'ride_id', v_ride),
    format('owner_car_given:%s:%s', q.id, x.recipient))
  from (select distinct r as recipient from unnest(array[q.requester_id, q.filed_by]) r) x
  where v_car.type = 'temporary' and x.recipient is not null and x.recipient <> v_uid;

  return jsonb_build_object('ok', true, 'ride_id', v_ride, 'car_id', v_car.id);
end $function$;

CREATE OR REPLACE FUNCTION public.place_on_own_car(p_request_id uuid, p_car_id uuid, p_allow_small_trunk boolean DEFAULT false)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  v_req public.requests%rowtype; v_actor uuid := (select auth.uid()); v_car public.cars%rowtype;
  v_ride uuid; v_by text; v_prop uuid; v_phase public.week_phase; v_turnaround int; v_end timestamptz;
begin
  perform public._small_trunk_mode(p_allow_small_trunk);   -- REQ §13.111 (a)
  select * into v_req from public.requests where id = p_request_id for update;
  if v_req.id is null then raise exception 'request_not_found' using errcode = 'P0001'; end if;
  -- REQ §13.127 (c): the owner may also put a request they filed for someone else (or are related to) on their car.
  if v_req.requester_id is distinct from v_actor and not public.request_related(p_request_id, v_actor) then
    raise exception 'not_authorized' using errcode = 'P0001';
  end if;
  select * into v_car from public.cars where id = p_car_id;
  if v_car.id is null or v_car.department_id <> v_req.department_id then raise exception 'not_authorized' using errcode = 'P0001'; end if;
  if v_car.type <> 'temporary' or not public.is_car_owner(v_car.id, v_actor) then raise exception 'private_car_owner_only' using errcode = 'P0001'; end if;
  if v_car.status <> 'active' then raise exception 'car_unavailable' using errcode = 'P0001'; end if;
  if v_req.status in ('assigned', 'merged', 'withdrawn', 'cancelled') or v_req.series_id is not null
     or exists (select 1 from public.ride_requests rr join public.rides r on r.id = rr.ride_id
                where rr.request_id = p_request_id and r.status <> 'cancelled') then
    raise exception 'request_not_editable' using errcode = 'P0001';
  end if;
  -- REQ §13.206: a one-way trip between two list places goes on my car too (it is left at the destination).
  if v_req.trip_type = 'one_way' then
    if v_req.depart_at is null or v_req.origin_id is null or v_req.destination_id is null then
      raise exception 'own_car_one_way_place' using errcode = 'P0001';
    end if;
    v_end := greatest(public._round_up_ride_end(v_req.depart_at,
      v_req.depart_at + make_interval(mins => greatest(coalesce(public.request_leg_route_minutes(p_request_id, 'out'), 30), 0))),
      v_req.depart_at + interval '15 minutes');
  elsif v_req.trip_type <> 'round_trip' or v_req.depart_at is null or v_req.return_at is null or v_req.origin_id is null then
    raise exception 'own_car_round_trip_only' using errcode = 'P0001';
  else
    v_end := v_req.return_at;
  end if;
  if v_req.depart_at < now() then raise exception 'ride_in_past' using errcode = 'P0001'; end if;
  select phase into v_phase from public.weeks where department_id = v_req.department_id and week_start = v_req.week_start;
  if v_phase is null or v_phase in ('archived', 'upcoming') then raise exception 'week_archived' using errcode = 'P0001'; end if;
  v_turnaround := coalesce(public.required_turnaround_minutes(v_req.department_id, v_req.week_start), 30);
  if exists (select 1 from public.rides r where r.car_id = p_car_id and r.status <> 'cancelled' and not r.draft_hold
             and tstzrange(r.starts_at, r.blocked_until, '[)') && tstzrange(v_req.depart_at, v_end + make_interval(mins => v_turnaround), '[)'))
     or exists (select 1 from public.car_maintenance_blocks b where b.car_id = p_car_id
             and tstzrange(b.starts_at, b.ends_at, '[)') && tstzrange(v_req.depart_at, v_end, '[)')) then
    raise exception 'own_car_not_free' using errcode = 'P0001';
  end if;

  perform set_config('app.audit_reason', 'place_on_own_car', true);
  for v_prop in
    select p.id from public.proposals p
    where p.status in ('draft', 'sent')
      and (p.request_id = p_request_id or exists (select 1 from public.proposal_parties pp where pp.proposal_id = p.id and pp.request_id = p_request_id))
    for update
  loop
    update public.proposals set status = 'withdrawn' where id = v_prop;
  end loop;

  perform set_config('app.system_status_transition', 'on', true);
  v_ride := public.place_request_on_car(p_request_id, p_car_id, false, v_actor, null, null, null, 'OWN_CAR');
  perform set_config('app.system_status_transition', 'off', true);

  select full_name into v_by from public.profiles where id = v_actor;
  perform public.enqueue_notification(s.profile_id, 'outcome_changed', v_req.department_id, v_req.week_start,
    jsonb_build_object('byName', coalesce(v_by, ''), 'route', coalesce(public.request_route_label(p_request_id), ''),
      'day', public.day_date_label(v_req.depart_at), 'car', v_car.name),
    jsonb_build_object('variant', 'own_car_placed', 'request_id', p_request_id, 'ride_id', v_ride,
      'url', format('/sadran/%s/%s/board', v_req.department_id, v_req.week_start)),
    format('own_car_placed:%s:%s', p_request_id, s.profile_id))
  from public.sadranim_of(v_req.department_id, v_req.week_start) as s(profile_id)
  where s.profile_id is distinct from v_actor;

  return jsonb_build_object('request_id', p_request_id, 'ride_id', v_ride, 'status', 'assigned', 'car_id', p_car_id);
end $function$;

CREATE OR REPLACE FUNCTION public.submit_request(payload jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  v_actor uuid := (select auth.uid());
  v_request_id uuid := nullif(payload ->> 'request_id', '')::uuid;
  v_requester_id uuid := coalesce(nullif(payload ->> 'requester_id', '')::uuid, v_actor);
  v_department_id uuid := (payload ->> 'department_id')::uuid;
  v_week_start date := (payload ->> 'week_start')::date;
  v_trip_shape public.trip_shape := coalesce((payload ->> 'trip_shape')::public.trip_shape, 'round_trip');
  v_depart_at timestamptz := nullif(payload ->> 'depart_at', '')::timestamptz;
  v_return_at timestamptz := nullif(payload ->> 'return_at', '')::timestamptz;
  v_one_way_mode public.leg_car_mode := nullif(payload ->> 'one_way_car_mode', '')::public.leg_car_mode;
  v_needs_car boolean := coalesce((payload ->> 'needs_car_at_destination')::boolean, true);
  v_preferred_car_id uuid := nullif(payload ->> 'preferred_car_id', '')::uuid;
  v_origin_id uuid := nullif(payload ->> 'origin_id', '')::uuid;
  v_origin_text text := nullif(payload ->> 'origin_text', '');
  v_trip_type_in text := nullif(payload ->> 'trip_type', '');
  v_trip_type public.trip_type;
  v_week record;
  v_existing record;
  v_can_manage boolean;
  v_is_late boolean;
  v_status public.request_status;
  v_warnings jsonb := '[]'::jsonb;
  v_join_ride_id uuid := nullif(payload ->> 'join_ride_id', '')::uuid;
  v_join_car_type public.car_type;
  v_ask_small boolean; v_allow_small boolean; v_small_car uuid; v_waived_here boolean := false; v_join_car uuid;
  v_join_owner uuid;
  v_auto_result jsonb;
  v_companion_ids uuid[];
  v_series_id uuid := nullif(payload ->> 'series_id', '')::uuid;
  v_series_index smallint := nullif(payload ->> 'series_index', '')::smallint;
  v_series_count smallint := nullif(payload ->> 'series_count', '')::smallint;
  v_eligible_driver uuid;
  v_kept timestamptz; v_prev_return timestamptz; v_prev_kept timestamptz;
  v_own_overlap boolean := false;
  -- Owner 2026-10-11: the requester answered "keep both" to the form's overlap warning (`overlap_confirmed`).
  v_overlap_confirmed boolean := coalesce((payload ->> 'overlap_confirmed')::boolean, false);
  v_overlap_unasked boolean := false;
  -- REQ §13.126 g: "הרכב זמין לשימוש ביעד" — a member-driven round trip whose car waits at the destination.
  v_keep_car boolean := coalesce((payload ->> 'keep_car_at_destination')::boolean, false);
  v_keep_car_id uuid;
  v_published_edit boolean := false; v_old_edit_car uuid; v_edit_ride uuid; v_edit_prev_sys text;
  v_needs_driver boolean;
  v_confirm boolean := coalesce((payload ->> 'confirm_release')::boolean, false);
  v_booking jsonb;
  v_probe jsonb;
  v_carry_from uuid;   -- REQ §13.205: the driver's ride whose added passengers go along to the new one
  v_carry_to uuid;
  v_carry_failed boolean := false;
  v_probe_away jsonb; v_away_car uuid;
  v_overlaps jsonb := '[]'::jsonb;
  v_probe_only boolean := coalesce((payload ->> 'probe_only')::boolean, false);
  v_late_variant text;
  v_depart_anchor public.time_anchor := 'leave'; v_arrive_by timestamptz;
  v_return_anchor public.time_anchor := 'arrive'; v_leave_dest_at timestamptz;
  v_anchors_explicit boolean := false;
  v_locked boolean := false;
  v_fallback public.request_fallback := 'none';
  v_is_edit boolean := nullif(payload ->> 'request_id', '') is not null;
  v_prev_fallback public.request_fallback := 'none'; v_prev_depart timestamptz; v_companion uuid;
  v_unchanged boolean := false; v_neutral boolean := false;
  -- REQ §13.127: filed for someone else; a member doing so follows the member's own flow (the requester's).
  v_on_behalf boolean;
  v_member_flow boolean;
  -- REQ §13.135 (c): a private car chosen in the form (the car's owner is the filer, the requester or who filed it).
  v_own_car uuid; v_own_turnaround int; v_own_by text; v_own_end timestamptz;
  v_hold_group uuid;
  -- REQ §13.169 (b): an edit may move the request to another rider (who drives); (c) a save from the request form.
  v_requester_changed boolean := false;
  v_form_notice boolean := public._ride_edit_notice_applies();
begin
  -- REQ §13.190: the browser asks before a short turnaround (`short_turnaround_ask`: try_auto_approve names the car's
  -- next ride instead of waitlisting) and retries with `allow_short_turnaround` once the member said yes.
  if coalesce((payload ->> 'allow_short_turnaround')::boolean, false) then
    perform set_config('app.short_turnaround', 'allow', true);
  elsif coalesce((payload ->> 'short_turnaround_ask')::boolean, false) then
    perform set_config('app.short_turnaround', 'offer', true);
  end if;
  -- REQ §13.127: an edit without `requester_id` keeps the stored requester (the editor may be anyone related).
  if v_request_id is not null and nullif(payload ->> 'requester_id', '') is null then
    select requester_id into v_requester_id from public.requests where id = v_request_id;
    v_requester_id := coalesce(v_requester_id, v_actor);
  end if;
  -- REQ §13.127: any approved member of the department may file for another member of it (checked below);
  -- before, only a Sadran could.
  v_can_manage := public.can_manage_week(v_department_id, v_week_start);
  v_on_behalf := v_actor is not null and v_requester_id <> v_actor;
  -- null (not false) for a session without a user, exactly like the `v_requester_id = v_actor` it replaces.
  v_member_flow := v_requester_id = v_actor or (v_on_behalf and not v_can_manage);
  -- REQ §13.135 (c): a private car is a preference only for its owner's requests (the owner files it, is the requester,
  -- or filed the request being edited); anyone else's private car (e.g. a grid tap on its column) is dropped, not refused.
  if v_preferred_car_id is not null and exists (
       select 1 from public.cars c where c.id = v_preferred_car_id and c.type = 'temporary'
         and not public.is_car_owner(c.id, v_actor) and not public.is_car_owner(c.id, v_requester_id)
         and (v_request_id is null or not public.is_car_owner(c.id, (select q.filed_by from public.requests q where q.id = v_request_id)))) then
    v_preferred_car_id := null;
  end if;

  select * into v_week from public.weeks where department_id = v_department_id and week_start = v_week_start;
  if v_week is null then
    raise exception 'week_not_open' using errcode = 'P0001';
  end if;
  -- REQ §13.77: a week that only exists as `upcoming` (materialized early for a series leg)
  -- is not open for an ordinary new request; series legs (series_id set) are exactly what
  -- put it there and are accepted.
  if v_week.phase = 'upcoming' and v_series_id is null then
    raise exception 'week_not_open' using errcode = 'P0001';
  end if;

  if not public.is_approved() or not public.member_of(v_department_id) and not v_can_manage then raise exception 'not_authorized'; end if;
  if v_week.phase = 'archived' then raise exception 'week_archived'; end if;
  -- REQ §13.100 (QB16): an immediate ("car now") request needs a live week. Refuse clearly instead of
  -- leaving it `submitted` in a week nobody is placing right now.
  if v_series_id is null and v_week.phase not in ('published', 'live') and not v_can_manage
     and v_depart_at is not null and v_depart_at <= now() + interval '1 hour'
     and v_depart_at >= now() - interval '1 hour' then
    raise exception 'car_now_week_not_live' using errcode = 'P0001';
  end if;
  -- REQ §13.155 (owner 2026-10-26): in a partly published week a day the Sadran has not published yet takes no
  -- member requests or edits (it was auto-approved onto a draft ride before); the week's Sadran still may.
  if v_week.phase in ('published', 'live') and not v_can_manage and cardinality(v_week.published_days) > 0
     and coalesce(v_depart_at, v_return_at) is not null
     and not ((coalesce(v_depart_at, v_return_at) at time zone 'Asia/Jerusalem')::date = any(v_week.published_days)) then
    raise exception 'day_not_published' using errcode = 'P0001';
  end if;
  if not exists (select 1 from public.department_members where department_id=v_department_id and profile_id=v_requester_id and removed_at is null) then raise exception 'not_authorized'; end if;

  if v_trip_shape <> 'round_trip' then
    v_needs_car := true;
    -- REQ §13.88: the member no longer chooses a car mode; when omitted, default to
    -- the requester's driving ability — a non-driver's leg is `passenger`, everyone
    -- else's is `relay`. An explicit value (Sadran/board, older clients) is kept as-is.
    if v_one_way_mode is null then
      select case when p.does_not_drive then 'passenger'::public.leg_car_mode else 'relay'::public.leg_car_mode end
        into v_one_way_mode
      from public.profiles p where p.id = v_requester_id;
    end if;
  end if;

  -- R6B7 (REQ §13.109): asking to join a ride the requester is already on is refused.
  if v_join_ride_id is not null and exists (
    select 1 from public.rides r where r.id = v_join_ride_id
      and (r.driver_id = v_requester_id
           or exists (select 1 from public.ride_passengers rp where rp.ride_id = r.id and rp.person_id = v_requester_id)
           or exists (select 1 from public.ride_requests rr join public.requests q on q.id = rr.request_id
                      where rr.ride_id = r.id and q.requester_id = v_requester_id and q.id is distinct from v_request_id)
           or exists (select 1 from public.ride_requests rr join public.request_companions rc on rc.request_id = rr.request_id
                      where rr.ride_id = r.id and rc.profile_id = v_requester_id))
  ) then
    raise exception 'join_own_ride' using errcode = 'P0001';
  end if;

  -- REQ §13.93: origin defaults to the requester's default_origin_id for this department,
  -- else the department home; an explicit origin_id/origin_text always wins.
  if v_origin_id is null and v_origin_text is null and v_join_ride_id is not null then
    select r.origin_id into v_origin_id from public.rides r where r.id = v_join_ride_id and r.department_id = v_department_id;
  end if;
  if v_origin_id is null and v_origin_text is null then
    select dm.default_origin_id into v_origin_id from public.department_members dm
      where dm.department_id = v_department_id and dm.profile_id = v_requester_id and dm.removed_at is null;
    if v_origin_id is null then
      select home_destination_id into v_origin_id from public.departments where id = v_department_id;
    end if;
  end if;

  -- R7B12 (REQ §13.109 e): the same place as origin and destination is refused.
  if (v_origin_id is not null and v_origin_id = nullif(payload ->> 'destination_id', '')::uuid)
     or (v_origin_text is not null and lower(btrim(v_origin_text)) = lower(btrim(coalesce(nullif(payload ->> 'destination_text', ''), '')))) then
    raise exception 'origin_equals_destination' using errcode = 'P0001';
  end if;

  -- REQ §13.93: trip_type is the source of truth when sent; otherwise derive it from the
  -- legacy fields above (same mapping as the 20261004100200 backfill).
  if v_trip_type_in is not null then
    v_trip_type := v_trip_type_in::public.trip_type;
    case v_trip_type
      when 'round_trip' then
        v_trip_shape := 'round_trip'; v_needs_car := true; v_one_way_mode := null;
      when 'one_way' then
        v_trip_shape := 'one_way_to'; v_needs_car := true; v_one_way_mode := 'relay';
      when 'drop_off' then
        if v_return_at is not null then
          v_trip_shape := 'round_trip'; v_needs_car := false; v_one_way_mode := null;
        else
          v_trip_shape := 'one_way_to'; v_needs_car := false;
          if v_one_way_mode is null then
            select case when p.does_not_drive then 'passenger'::public.leg_car_mode else 'relay'::public.leg_car_mode end
              into v_one_way_mode
            from public.profiles p where p.id = v_requester_id;
          end if;
        end if;
    end case;
  else
    v_trip_type := case when v_trip_shape = 'round_trip' and v_needs_car then 'round_trip'::public.trip_type else 'drop_off'::public.trip_type end;
  end if;
  -- REQ §13.126 g: only a two-way trip the requester drives (stored as a הקפצה with a pickup) keeps the car at the destination.
  if v_keep_car and (v_trip_type <> 'drop_off' or v_trip_shape <> 'round_trip'
     or exists (select 1 from public.profiles p where p.id = v_requester_id and p.does_not_drive)) then
    raise exception 'invalid_keep_car_at_destination' using errcode = 'P0001';
  end if;

  if v_request_id is not null then
    select * into v_existing from public.requests where id = v_request_id for update;
    if v_existing is null then
      raise exception 'request_not_found' using errcode = 'P0001';
    end if;
    -- REQ §13.127: everyone related to the request may edit it, not only the requester.
    if v_existing.requester_id <> v_actor and not public.request_related(v_request_id, v_actor)
       and not public.can_manage_week(v_existing.department_id, v_existing.week_start) then
      raise exception 'not_authorized' using errcode = 'P0001';
    end if;
    if v_existing.department_id is distinct from v_department_id or v_existing.week_start is distinct from v_week_start then raise exception 'not_authorized'; end if;
    -- REQ §13.169 (b): the who chip moves the request to the rider who drives (a member of the department, checked above).
    v_requester_changed := v_existing.requester_id is distinct from v_requester_id;
    -- REQ §13.169 (c): what the riders saw before this save.
    perform public._ride_edit_capture(v_request_id);
    -- REQ §13.77 v1: a multi-day series is cancelled and resubmitted, never edited leg by leg.
    if v_existing.series_id is not null or v_series_id is not null then
      raise exception 'series_edit_not_supported' using errcode = 'MDR02';
    end if;
    -- REQ §13.101 (f): on a published/live day the requester may edit their own request; the new
    -- version is placed (or released to the waiting list after a confirmation). A closed, unpublished
    -- day keeps request_window_closed (the member contacts the Sadran).
    -- REQ §13.127: so may anyone related to it (who filed it, a companion, someone on its ride, the private car's owner).
    v_published_edit := v_week.phase in ('published', 'live')
      and (v_requester_id = v_actor or (v_actor is not null and public.request_related(v_request_id, v_actor)));
    if v_published_edit then
      if coalesce(v_existing.return_at, v_existing.depart_at) < now() then raise exception 'request_not_editable'; end if;
    elsif not v_can_manage and (v_week.phase not in ('open','solving') or now() > v_week.close_at or now() < v_week.open_at) then raise exception 'request_window_closed'; end if;
    if v_existing.served_by_alternative then raise exception 'request_served_by_alternative' using errcode = 'P0001'; end if;
    if v_existing.status in ('cancelled','withdrawn') or (not v_published_edit and exists(select 1 from public.ride_requests rr join public.rides r on r.id=rr.ride_id where rr.request_id=v_request_id and r.status not in ('draft','cancelled'))) then raise exception 'request_not_editable'; end if;
    -- REQ §13.101 (h), R11B1: a save whose effective content equals the stored request changes nothing.
    v_unchanged := public._request_save_unchanged(v_request_id, payload, v_trip_type, v_trip_shape, v_needs_car, v_one_way_mode,
      v_origin_id, v_origin_text, v_depart_at, v_return_at);
    -- placement-neutral edit on a published/live day: only notes / description / ride type / preferred car / plan B changed
    v_neutral := v_published_edit and not v_unchanged and public._request_save_unchanged(v_request_id, payload, v_trip_type, v_trip_shape, v_needs_car,
      v_one_way_mode, v_origin_id, v_origin_text, v_depart_at, v_return_at, true);
    -- REQ §13.126 g: turning "the car is available at the destination" on or off changes how the trip is placed.
    if v_existing.keep_car_at_destination is distinct from v_keep_car or v_requester_changed then
      v_unchanged := false;
      v_neutral := false;
    end if;
    -- REQ §13.102 (f), R2B20: the form asks before saving whether an edit would lose the current booking.
    if v_probe_only then
      return jsonb_build_object('probe_only', true, 'request_id', v_request_id, 'unchanged', v_unchanged, 'placement_neutral', v_neutral,
        -- REQ §13.158: a published/live-day edit never loses its booking (it is placed or refused).
        'would_lose_booking', not v_published_edit and not v_unchanged and not v_neutral and (v_existing.status in ('assigned', 'merged', 'proposed') or exists (
          select 1 from public.ride_requests rr join public.rides r on r.id = rr.ride_id
          where rr.request_id = v_request_id and r.status <> 'cancelled')),
        'drives_others', coalesce((public.request_booking_info(v_request_id) ->> 'drives_others')::boolean, false),
        'affected_names', coalesce(public.request_booking_info(v_request_id) -> 'affected_names', '[]'::jsonb));
    end if;
    if not (payload ? 'expected_version') then perform public.raise_stale_version(); end if;
    if v_existing.version is distinct from (payload ->> 'expected_version')::int then
      perform public.raise_stale_version();
    end if;
    if v_unchanged then
      return jsonb_build_object('ok', true, 'unchanged', true, 'request_id', v_request_id, 'status', v_existing.status,
        'is_late', v_existing.is_late, 'warnings', '[]'::jsonb, 'overlaps', '[]'::jsonb);
    end if;
    if v_neutral then
      -- stored in place (the plan B is validated and saved by the same helper a normal edit uses)
      perform set_config('app.audit_reason', 'submit_request', true);
      update public.requests set
        notes = case when payload ? 'notes' then nullif(payload ->> 'notes', '') else notes end,
        ride_type_id = coalesce((payload ->> 'ride_type_id')::uuid, ride_type_id),
        ride_description = case when payload ? 'ride_description' then payload ->> 'ride_description' else ride_description end,
        preferred_car_id = case when payload ? 'preferred_car_id' then v_preferred_car_id else preferred_car_id end,
        fallback = public._request_fallback_from_payload(payload, fallback)
      where id = v_request_id;
      if payload ? 'fallback' or payload ? 'alternative' or v_existing.fallback <> 'none' then
        perform public._save_request_alternative(v_request_id, payload, v_existing.depart_at);
      end if;
      perform public.enqueue_notification(s.profile_id, 'request_changed', v_department_id, v_week_start,
        jsonb_build_object('requestId', v_request_id::text), jsonb_build_object('request_id', v_request_id),
        format('request_changed:%s:%s', v_request_id, now()))
      from public.sadranim_of(v_department_id, v_week_start) as s(profile_id);
      if not v_form_notice then perform public._notify_request_edited_by_manager(v_request_id, v_actor); end if;
      return jsonb_build_object('ok', true, 'placement_neutral', true, 'unchanged', false, 'request_id', v_request_id,
        'status', v_existing.status, 'is_late', v_existing.is_late, 'warnings', '[]'::jsonb, 'overlaps', '[]'::jsonb);
    end if;
    if v_published_edit then
      v_booking := public.request_booking_info(v_request_id);
      if (v_booking ->> 'has_booking')::boolean and coalesce(current_setting('app.edit_probe_inner', true), 'off') <> 'on' then
        -- Probe: run the whole edit (release + new placement) in a subtransaction. A clean move onto a
        -- free car is kept (with others on the ride only once the member confirmed); anything else is rolled back.
        -- REQ §13.205 (owner 2026-11-09, production: a driver shortened his ride and the member who had joined it with
        -- "add passengers" was dropped): when the member drives their own ride and nobody else's request is on it — only people
        -- added to it — those people go along to wherever the new hours are placed; no question asked.
        select r.id into v_carry_from
        from public.ride_requests rr join public.rides r on r.id = rr.ride_id
        where rr.request_id = v_request_id and r.status not in ('cancelled', 'draft') and r.driver_id = v_existing.requester_id
          and exists (select 1 from public.ride_passengers rp where rp.ride_id = r.id)
          and not exists (select 1 from public.ride_requests x where x.ride_id = r.id and x.request_id <> v_request_id)
          and (select count(*) from public.ride_requests y join public.rides ry on ry.id = y.ride_id
               where y.request_id = v_request_id and ry.status not in ('cancelled', 'draft')) = 1;
        begin
          perform set_config('app.edit_probe_inner', 'on', true);
          v_probe := public.submit_request(payload || jsonb_build_object('confirm_release', true));
          perform set_config('app.edit_probe_inner', 'off', true);
          -- REQ §13.176: the new hours would be placed but overlap the member's own ride or request: ask first
          if coalesce(v_probe ->> 'status', '') = 'assigned' and coalesce((v_probe ->> 'overlap_unasked')::boolean, false) then
            perform public._ask_request_overlap(v_requester_id, v_depart_at, v_return_at, v_request_id);
          end if;
          if v_carry_from is not null and coalesce(v_probe ->> 'status', '') = 'assigned' then
            select r.id into v_carry_to
            from public.ride_requests rr join public.rides r on r.id = rr.ride_id
            where rr.request_id = v_request_id and r.status not in ('cancelled', 'draft') and r.id <> v_carry_from
            order by r.starts_at limit 1;
            -- the new ride must seat the request and everyone added (the request's own seats are on its row)
            if v_carry_to is null or not public.car_fits((select car_id from public.rides where id = v_carry_to),
                 (select coalesce(q.adults, 1) from public.requests q where q.id = v_request_id)::int
                   + (select count(*) from public.ride_passengers rp where rp.ride_id = v_carry_from and rp.seat_kind = 'adult')::int,
                 (select coalesce(q.child_seats, 0) from public.requests q where q.id = v_request_id)::int
                   + (select count(*) from public.ride_passengers rp where rp.ride_id = v_carry_from and rp.seat_kind = 'child_seat')::int,
                 (select coalesce(q.boosters, 0) from public.requests q where q.id = v_request_id)::int
                   + (select count(*) from public.ride_passengers rp where rp.ride_id = v_carry_from and rp.seat_kind = 'booster')::int) then
              v_carry_failed := true;
              raise exception 'release_probe_rollback' using errcode = 'PXRP1';
            end if;
            update public.ride_passengers set ride_id = v_carry_to where ride_id = v_carry_from;
            -- they were told the old ride was cancelled a moment ago; they are not losing it (the edit notice tells them
            -- the new hours), so that notice is taken back before it is delivered (its outbox rows go with it)
            delete from public.notifications n
            where n.event = 'outcome_changed' and n.data ->> 'variant' = 'ride_cancelled' and n.data ->> 'ride_id' = v_carry_from::text
              and n.recipient_id in (select rp.person_id from public.ride_passengers rp where rp.ride_id = v_carry_to);
            perform set_config('app.edit_probe_inner', 'off', true);
            return v_probe;
          end if;
          if coalesce(v_probe ->> 'status', '') = 'assigned' and (v_confirm or not (v_booking ->> 'drives_others')::boolean) then
            return v_probe;
          end if;
          raise exception 'release_probe_rollback' using errcode = 'PXRP1';
        exception when sqlstate 'PXRP1' then
          null;
        end;
        if coalesce(v_probe ->> 'status', '') = 'assigned' and not v_carry_failed then
          -- the new hours fit a car, but the member drives others who would be left without a driver: ask
          return jsonb_build_object('needs_confirmation', 'release_to_waitlist', 'unchanged', false,
            'drives_others', true, 'would_place', true,
            'affected_names', coalesce(v_booking -> 'affected_names', '[]'::jsonb));
        end if;
        -- OW1 (REQ §13.210): a change to one way that is refused only because the booked car would stay at the
        -- destination (its next ride starts elsewhere, or the week ends with it away from its base) asks instead:
        -- nothing changes now; the form resubmits with `allow_car_away`.
        if v_trip_type = 'one_way' and not coalesce((payload ->> 'allow_car_away')::boolean, false) then
          select r.car_id into v_away_car from public.ride_requests rr join public.rides r on r.id = rr.ride_id
          where rr.request_id = v_request_id and r.status <> 'cancelled' order by r.starts_at limit 1;
          begin
            perform set_config('app.edit_probe_inner', 'on', true);
            v_probe_away := public.submit_request(payload || jsonb_build_object('confirm_release', true, 'allow_car_away', true));
            raise exception 'release_probe_rollback' using errcode = 'PXRP1';
          exception when sqlstate 'PXRP1' then
            null;
          end;
          perform set_config('app.edit_probe_inner', 'off', true);
          perform set_config('app.car_stays_away', '', true);
          if coalesce(v_probe_away ->> 'status', '') = 'assigned'
             and (v_confirm or not coalesce((v_booking ->> 'drives_others')::boolean, false)) then
            return jsonb_build_object('ok', false, 'needs_confirmation', 'car_stays_away', 'unchanged', false,
              'request_id', v_request_id, 'status', v_existing.status,
              'car_name', (select c.name from public.cars c where c.id = v_away_car),
              -- which of the two reasons: a later ride of the car (true), or none and the car ends away from its base
              'next_ride', public.car_next_ride_origin(v_away_car, v_depart_at + interval '1 minute') is not null,
              'warnings', '[]'::jsonb, 'overlaps', '[]'::jsonb);
          end if;
        end if;
        -- REQ §13.158: an edit never costs the member the car. No car takes the new hours, so nothing changes;
        -- `discussion` when an open waiting-list discussion holds the car in those hours (try_auto_approve's offer).
        v_hold_group := coalesce(nullif(v_probe ->> 'group_offer', '')::uuid, (
          select public.waitlist_group_holding(c.id, v_depart_at,
            coalesce(v_return_at, v_depart_at) + make_interval(mins => coalesce(public.required_turnaround_minutes(v_department_id, v_week_start), 30)), v_request_id)
          from public.cars c
          where c.department_id = v_department_id and c.status = 'active' and c.type = 'shared'
            and public.waitlist_group_holding(c.id, v_depart_at,
              coalesce(v_return_at, v_depart_at) + make_interval(mins => coalesce(public.required_turnaround_minutes(v_department_id, v_week_start), 30)), v_request_id) is not null
          order by c.id limit 1));
        -- QA run 17 R17B13: `riders` when the member drives others on the ride — the car stays with them, so the new
        -- hours need the Sadran (or the riders' own edits), not "no car".
        return jsonb_build_object('ok', false, 'edit_refused', case when v_hold_group is not null then 'discussion'
            when coalesce((v_booking ->> 'drives_others')::boolean, false) then 'riders' else 'no_car' end,
          'group_offer', v_hold_group, 'short_turnaround', v_probe -> 'short_turnaround', 'request_id', v_request_id, 'unchanged', false, 'status', v_existing.status,
          'warnings', '[]'::jsonb, 'overlaps', '[]'::jsonb);
      end if;
    end if;
  end if;

  if v_probe_only then
    return jsonb_build_object('probe_only', true, 'would_lose_booking', false, 'unchanged', false);
  end if;

  -- A one-way shape stores no return_at: remember the last real one (payload, else the stored one) in
  -- kept_return_at; a shape that needs a return and got none gets the kept one back.
  if v_request_id is not null then
    v_prev_return := v_existing.return_at; v_prev_kept := v_existing.kept_return_at;
    v_prev_fallback := v_existing.fallback; v_prev_depart := v_existing.depart_at;
  end if;
  -- REQ §13.112 (a)/(b): the fallback this submit stores (validated token; the plan B row is written below).
  v_fallback := public._request_fallback_from_payload(payload, v_prev_fallback);
  if v_trip_shape = 'one_way_to' then
    v_kept := coalesce(v_return_at, v_prev_return, v_prev_kept);
    v_return_at := null;
  else
    v_return_at := coalesce(v_return_at, v_prev_kept);
  end if;

  -- REQ §13.110 (b): the way each end was entered. Stored values (update) or defaults (insert) unless the
  -- payload carries the keys; an explicit key set is validated as a whole.
  if v_request_id is not null then
    v_depart_anchor := v_existing.depart_anchor; v_arrive_by := v_existing.arrive_by;
    v_return_anchor := v_existing.return_anchor; v_leave_dest_at := v_existing.leave_dest_at;
  end if;
  if payload ? 'depart_anchor' or payload ? 'arrive_by' then
    if nullif(payload ->> 'depart_anchor', '') is not null and (payload ->> 'depart_anchor') not in ('leave', 'arrive') then
      raise exception 'invalid_anchor' using errcode = 'P0001';
    end if;
    v_depart_anchor := coalesce(nullif(payload ->> 'depart_anchor', '')::public.time_anchor, v_depart_anchor);
    v_arrive_by := nullif(payload ->> 'arrive_by', '')::timestamptz;
    v_anchors_explicit := true;
  end if;
  if payload ? 'return_anchor' or payload ? 'leave_dest_at' then
    if nullif(payload ->> 'return_anchor', '') is not null and (payload ->> 'return_anchor') not in ('leave', 'arrive') then
      raise exception 'invalid_anchor' using errcode = 'P0001';
    end if;
    v_return_anchor := coalesce(nullif(payload ->> 'return_anchor', '')::public.time_anchor, v_return_anchor);
    v_leave_dest_at := nullif(payload ->> 'leave_dest_at', '')::timestamptz;
    v_anchors_explicit := true;
  end if;
  if v_anchors_explicit then
    if (v_depart_anchor = 'arrive') <> (v_arrive_by is not null) then
      raise exception 'anchor_time_mismatch' using errcode = 'P0001';
    end if;
    -- A one-way request keeps its (inactive) leave-there time (REQ §13.97), so only a request with a
    -- return needs the return end to be consistent.
    if (v_return_at is not null and (v_return_anchor = 'leave') <> (v_leave_dest_at is not null))
       or (v_return_anchor <> 'leave' and v_leave_dest_at is not null) then
      raise exception 'anchor_time_mismatch' using errcode = 'P0001';
    end if;
    if v_arrive_by is not null and (
         not public.is_quarter_hour(v_arrive_by) or v_depart_at is null
         or (v_arrive_by at time zone 'Asia/Jerusalem')::date
              not between (v_depart_at at time zone 'Asia/Jerusalem')::date and (v_depart_at at time zone 'Asia/Jerusalem')::date + 1) then
      raise exception 'invalid_anchor_time' using errcode = 'P0001';
    end if;
    if v_leave_dest_at is not null and (
         not public.is_quarter_hour(v_leave_dest_at)
         or (coalesce(v_return_at, v_kept, v_depart_at) is not null and (v_leave_dest_at at time zone 'Asia/Jerusalem')::date
              not between (coalesce(v_return_at, v_kept, v_depart_at) at time zone 'Asia/Jerusalem')::date - 1
                      and (coalesce(v_return_at, v_kept, v_depart_at) at time zone 'Asia/Jerusalem')::date)) then
      raise exception 'invalid_anchor_time' using errcode = 'P0001';
    end if;
  end if;

  -- REQ §13.112 (c): "N hours somewhere in a window". An explicit `duration_locked` is validated as a whole; without the
  -- key the stored lock survives only an edit that keeps the block's length (a classic-form edit of the times drops it).
  if payload ? 'duration_locked' then
    v_locked := coalesce((payload ->> 'duration_locked')::boolean, false);
    if v_locked then
      perform public.assert_duration_lock(v_trip_type, v_series_id, v_depart_at, v_return_at,
        coalesce(nullif(payload ->> 'flex_depart_early', '')::interval, '0'), coalesce(nullif(payload ->> 'flex_depart_late', '')::interval, '0'),
        coalesce(nullif(payload ->> 'flex_return_early', '')::interval, '0'), coalesce(nullif(payload ->> 'flex_return_late', '')::interval, '0'),
        v_depart_anchor, v_return_anchor);
    end if;
  elsif v_request_id is not null then
    v_locked := v_existing.duration_locked and v_return_at - v_depart_at = v_existing.return_at - v_existing.depart_at;
  end if;

  if coalesce((payload->>'reserve_missing_driver')::boolean,false) and (
    v_request_id is not null or (v_requester_id is distinct from v_actor and not coalesce(v_member_flow, false)) or v_week.phase<>'live' or v_trip_shape='round_trip' or v_trip_type<>'drop_off' or v_join_ride_id is not null
  ) then raise exception 'invalid_quick_reservation';end if;
  if v_request_id is not null then perform public.release_request_draft_rides(v_request_id); end if;
  if v_request_id is not null and v_published_edit and coalesce((v_booking ->> 'has_booking')::boolean, false) then
    -- confirmed (or probed) release of the old booking; the request starts over as `submitted`.
    -- R3B14: remember the booked car so the re-placement keeps it when it still fits.
    select r.car_id into v_old_edit_car from public.ride_requests rr join public.rides r on r.id = rr.ride_id
    where rr.request_id = v_request_id and r.status <> 'cancelled' order by r.starts_at limit 1;
    perform set_config('app.edit_prefer_car', coalesce(v_old_edit_car::text, ''), true);
    -- OW1 (REQ §13.210): the member said yes to leaving the booked car at the destination.
    perform set_config('app.car_stays_away', case when v_trip_type = 'one_way' and coalesce((payload ->> 'allow_car_away')::boolean, false)
      then coalesce(v_old_edit_car::text, '') else '' end, true);
    -- REQ §13.158: the old booking keeps counting against waiting-list holds (car_held_by_waitlist_group).
    perform set_config('app.edit_kept_rides', coalesce((select jsonb_agg(jsonb_build_object('car', r.car_id, 'from', r.starts_at, 'until', r.blocked_until))
      from public.ride_requests rr join public.rides r on r.id = rr.ride_id
      where rr.request_id = v_request_id and r.status <> 'cancelled' and r.car_id is not null), '[]'::jsonb)::text, true);
    perform public.release_request_booking(v_request_id);
    perform set_config('app.system_status_transition', 'on', true);
    update public.requests set status = 'submitted', status_reason = null where id = v_request_id;
    perform set_config('app.system_status_transition', 'off', true);
  end if;

  v_is_late := now() > v_week.close_at;
  -- R13M3: the Sadran editing someone else's request after the closing time does not make it late — it keeps its
  -- own lateness (no "late request" notice either; R13B15 already keeps the acting Sadran out of the Sadran notices).
  if v_request_id is not null and v_can_manage then   -- an edit (v_existing is only loaded for one)
    if v_existing.requester_id is distinct from v_actor then
      v_is_late := coalesce(v_existing.is_late, false);
    end if;
  end if;
  -- R2U4: a late request tells the Sadranim once (below), with its outcome, instead of late + waitlisted + contested.
  perform set_config('app.late_request_notice', case when v_is_late and v_series_id is null and not coalesce((payload->>'reserve_missing_driver')::boolean,false) then 'on' else 'off' end, true);

  perform set_config('app.audit_reason', 'submit_request', true);

  perform set_config('app.reset_request_baseline',case when v_member_flow then 'on' else 'off' end,true);
  if v_request_id is null then
    v_status := 'submitted';
    insert into public.requests (
      department_id, week_start, requester_id, filed_by, destination_id, destination_text, ride_type_id,
      origin_id, origin_text, trip_type,
      trip_shape, depart_at, return_at, one_way_car_mode, needs_car_at_destination,
      adults, child_seats, boosters, has_luggage, needs_tow_hitch,
      flex_depart_early, flex_depart_late, flex_return_early, flex_return_late,
      notes, is_late, submitted_at, status, freed_slot_opt_out, join_ride_id, template_id, preferred_car_id,
      series_id, series_index, series_count, kept_return_at,
      depart_anchor, arrive_by, return_anchor, leave_dest_at, duration_locked, fallback, keep_car_at_destination
    ) values (
      v_department_id, v_week_start, v_requester_id, v_actor,
      nullif(payload ->> 'destination_id', '')::uuid, nullif(payload ->> 'destination_text', ''),
      (payload ->> 'ride_type_id')::uuid,
      v_origin_id, v_origin_text, v_trip_type,
      v_trip_shape, v_depart_at, v_return_at, v_one_way_mode, v_needs_car,
      coalesce((payload ->> 'adults')::smallint, 1), coalesce((payload ->> 'child_seats')::smallint, 0),
      coalesce((payload ->> 'boosters')::smallint, 0), coalesce((payload ->> 'has_luggage')::boolean, false),
      coalesce((payload ->> 'needs_tow_hitch')::boolean, false),
      coalesce(nullif(payload ->> 'flex_depart_early', '')::interval, '0'),
      coalesce(nullif(payload ->> 'flex_depart_late', '')::interval, '0'),
      coalesce(nullif(payload ->> 'flex_return_early', '')::interval, '0'),
      coalesce(nullif(payload ->> 'flex_return_late', '')::interval, '0'),
      nullif(payload ->> 'notes', ''), v_is_late, now(), v_status,
      coalesce((payload ->> 'freed_slot_opt_out')::boolean, false),
      v_join_ride_id, nullif(payload ->> 'template_id', '')::uuid, v_preferred_car_id,
      v_series_id, v_series_index, v_series_count, v_kept,
      v_depart_anchor, v_arrive_by, v_return_anchor, v_leave_dest_at, v_locked, v_fallback, v_keep_car
    ) returning id into v_request_id;
  else
    -- The shift trigger moves a stored entered time with depart_at/return_at unless this statement sets it.
    perform set_config('app.request_anchors_explicit', case when v_anchors_explicit then 'on' else 'off' end, true);
    perform set_config('app.duration_lock_explicit', 'on', true);
    update public.requests set
      requester_id = v_requester_id,
      destination_id = nullif(payload ->> 'destination_id', '')::uuid,
      destination_text = nullif(payload ->> 'destination_text', ''),
      ride_type_id = (payload ->> 'ride_type_id')::uuid,
      origin_id = v_origin_id, origin_text = v_origin_text, trip_type = v_trip_type,
      trip_shape = v_trip_shape, depart_at = v_depart_at, return_at = v_return_at, kept_return_at = v_kept,
      one_way_car_mode = v_one_way_mode, needs_car_at_destination = v_needs_car,
      adults = coalesce((payload ->> 'adults')::smallint, adults),
      child_seats = coalesce((payload ->> 'child_seats')::smallint, child_seats),
      boosters = coalesce((payload ->> 'boosters')::smallint, boosters),
      has_luggage = coalesce((payload ->> 'has_luggage')::boolean, has_luggage),
      needs_tow_hitch = coalesce((payload ->> 'needs_tow_hitch')::boolean, needs_tow_hitch),
      flex_depart_early = coalesce(nullif(payload ->> 'flex_depart_early', '')::interval, flex_depart_early),
      flex_depart_late = coalesce(nullif(payload ->> 'flex_depart_late', '')::interval, flex_depart_late),
      flex_return_early = coalesce(nullif(payload ->> 'flex_return_early', '')::interval, flex_return_early),
      flex_return_late = coalesce(nullif(payload ->> 'flex_return_late', '')::interval, flex_return_late),
      notes = case when payload ? 'notes' then nullif(payload ->> 'notes','') else notes end,
      is_late = v_is_late,
      freed_slot_opt_out = coalesce((payload ->> 'freed_slot_opt_out')::boolean, freed_slot_opt_out),
      join_ride_id = coalesce(v_join_ride_id, join_ride_id),
      preferred_car_id = case when payload ? 'preferred_car_id' then v_preferred_car_id else preferred_car_id end,
      depart_anchor = v_depart_anchor, arrive_by = v_arrive_by,
      return_anchor = v_return_anchor, leave_dest_at = v_leave_dest_at, duration_locked = v_locked,
      fallback = v_fallback,
      keep_car_at_destination = v_keep_car,
      changed_since_solve = (v_week.phase not in ('open','solving'))
    where id = v_request_id
    returning status into v_status;
    perform set_config('app.request_anchors_explicit', 'off', true);
    perform set_config('app.duration_lock_explicit', 'off', true);
    -- REQ §13.169 (b): the new requester is no longer a companion of their own request (the form sends the rest).
    if v_requester_changed then
      delete from public.request_companions where request_id = v_request_id and profile_id = v_requester_id;
    end if;

    if v_week.phase in ('solving','published','live') then
      perform public.enqueue_notification(s.profile_id, 'request_changed', v_department_id, v_week_start,
        jsonb_build_object('requestId', v_request_id::text), jsonb_build_object('request_id', v_request_id),
        format('request_changed:%s:%s', v_request_id, now()))
      from public.sadranim_of(v_department_id, v_week_start) as s(profile_id);
    end if;
    if not v_form_notice then perform public._notify_request_edited_by_manager(v_request_id, v_actor); end if;
  end if;

  perform set_config('app.reset_request_baseline','off',true);
  if payload ? 'ride_description' or payload ? 'guest_passenger_names' then
    if payload ? 'ride_description' and jsonb_typeof(payload->'ride_description') not in ('string','null') then raise exception 'invalid_ride_description';end if;
    if payload ? 'guest_passenger_names' and jsonb_typeof(payload->'guest_passenger_names') not in ('array','null') then raise exception 'invalid_passenger_names';end if;
    if payload ? 'guest_passenger_names' and jsonb_typeof(payload->'guest_passenger_names')='array' and exists(
      select 1 from jsonb_array_elements(payload->'guest_passenger_names') value where jsonb_typeof(value)<>'string') then raise exception 'invalid_passenger_names';end if;
    update public.requests set ride_description=case when payload ? 'ride_description' then payload->>'ride_description' else ride_description end,
      guest_passenger_names=case when payload ? 'guest_passenger_names' then array(select jsonb_array_elements_text(case when payload->'guest_passenger_names'='null'::jsonb then '[]'::jsonb else payload->'guest_passenger_names' end)) else guest_passenger_names end
      where id=v_request_id;
  end if;
  if payload ? 'companion_ids' then
    if jsonb_typeof(payload->'companion_ids') not in ('array','null') then raise exception 'invalid_companions';end if;
    select array_agg(value::uuid) into v_companion_ids from jsonb_array_elements_text(case when payload->'companion_ids'='null'::jsonb then '[]'::jsonb else payload->'companion_ids' end);
    if cardinality(v_companion_ids)>20 or cardinality(v_companion_ids)<>(select count(distinct id) from unnest(v_companion_ids) id)
      or exists(select 1 from unnest(v_companion_ids) candidate(profile_id) where candidate.profile_id=v_requester_id or not exists(
        select 1 from public.profiles p join public.department_members dm on dm.profile_id=p.id where p.id=candidate.profile_id
        and p.approval_status='approved' and dm.department_id=v_department_id and dm.removed_at is null)) then raise exception 'invalid_companions';end if;
    delete from public.request_companions where request_id=v_request_id;
    insert into public.request_companions(request_id,profile_id) select v_request_id,id from unnest(v_companion_ids) id;
  end if;
  if payload ? 'guest_passenger_names' or payload ? 'companion_ids' then perform public.assert_named_passenger_counts(v_request_id);end if;

  -- REQ §13.93 "Multi-stop rides": payload `stops` replaces the request's whole set, in route
  -- order per leg; absent key = leave existing stops untouched (same convention as `notes`).
  if payload ? 'stops' then
    perform public.replace_request_stops(v_request_id, v_department_id, v_return_at is not null, payload -> 'stops');
  end if;

  -- REQ §13.112 (a)/(b): plan B / "אסתדר" (validated against the row just written; keys absent = keep, moved with the day).
  if payload ? 'fallback' or payload ? 'alternative' or (v_is_edit and v_fallback <> 'none') then
    perform public._save_request_alternative(v_request_id, payload, v_prev_depart);
  end if;

  -- REQ §13.93: a requester who does not drive, and has no driving companion on board,
  -- may only file a הקפצה (drop_off) -- checked after companions are written above.
  if v_trip_type <> 'drop_off' then
    v_eligible_driver := public.eligible_leg_driver(v_request_id);
    if v_eligible_driver is null then
      raise exception 'non_driver_needs_drop_off' using errcode = 'P0001';
    end if;
  end if;

  -- Duplicate detection (warn, never block, REQ §5.3).
  if exists (
    select 1 from public.requests q
    where q.requester_id = v_requester_id and q.id <> v_request_id and q.status not in ('withdrawn','cancelled','denied','external')
      and q.department_id = v_department_id
      -- REQ §13.77: the legs of one multi-day series overlap each other by construction.
      and (v_series_id is null or q.series_id is distinct from v_series_id)
      and public.request_span(q.depart_at, q.return_at) && public.request_span(v_depart_at, v_return_at)
  ) then
    v_warnings := v_warnings || '"DUPLICATE_OVERLAP"'::jsonb;
    v_own_overlap := v_series_id is null;
  end if;
  -- REQ §13.100 (QB8): an overlapping ride the member already has (driver, or named on a reservation),
  -- not only an overlapping request.
  -- REQ §13.176: only the member's own part of that ride counts (a pickup on the way back leaves the morning free).
  if v_series_id is null and not v_own_overlap and (
    exists (select 1 from public._person_busy_rides(v_requester_id, public.request_span(v_depart_at, v_return_at), null, v_request_id, false) b
            join public.rides r on r.id = b.ride_id where r.department_id = v_department_id)
    or (v_join_ride_id is not null and exists (
      select 1 from public._person_busy_rides(v_requester_id, (select tstzrange(j.starts_at, j.ends_at, '[)') from public.rides j where j.id = v_join_ride_id),
                                              v_join_ride_id, v_request_id, false) b
      join public.rides r on r.id = b.ride_id where r.department_id = v_department_id))
  ) then
    v_warnings := v_warnings || '"DUPLICATE_OVERLAP"'::jsonb;
    v_own_overlap := true;
  end if;

  -- REQ §13.101 (g): name the member's own overlapping requests/rides so the form can offer to cancel one.
  if v_series_id is null then
    select coalesce(jsonb_agg(x.o), '[]'::jsonb) into v_overlaps from (
      select jsonb_build_object('request_id', y.request_id, 'ride_id', y.ride_id) as o from (
        select q.id as request_id,
               (select rr.ride_id from public.ride_requests rr join public.rides r on r.id = rr.ride_id
                 where rr.request_id = q.id and r.status not in ('cancelled', 'draft') order by r.starts_at limit 1) as ride_id
        from public.requests q
        where q.requester_id = v_requester_id and q.id <> v_request_id and q.department_id = v_department_id
          and q.status not in ('withdrawn','cancelled','denied','external')
          and public.request_span(q.depart_at, q.return_at) && public.request_span(v_depart_at, v_return_at)
        union
        select (select rr.request_id from public.ride_requests rr join public.requests rq on rq.id = rr.request_id
                 where rr.ride_id = r.id and rq.requester_id = v_requester_id order by rr.request_id limit 1), r.id
        from public.rides r
        where r.department_id = v_department_id
          and (r.id in (select b.ride_id from public._person_busy_rides(v_requester_id, public.request_span(v_depart_at, v_return_at), null, v_request_id, false) b)
           or (v_join_ride_id is not null and r.id in (select b.ride_id from public._person_busy_rides(v_requester_id,
                 (select tstzrange(j.starts_at, j.ends_at, '[)') from public.rides j where j.id = v_join_ride_id), v_join_ride_id, v_request_id, false) b)))
      ) y
    ) x;
  end if;

  -- Seat-fit warning (warn, never block).
  if not exists (
    select 1 from public.cars c join public.car_seat_configs csc on csc.car_id = c.id
    where c.department_id = v_department_id and c.status = 'active'
      and csc.adults >= coalesce((payload ->> 'adults')::smallint, 1)
      and csc.child_seats >= coalesce((payload ->> 'child_seats')::smallint, 0)
      and csc.boosters >= coalesce((payload ->> 'boosters')::smallint, 0)
  ) then
    v_warnings := v_warnings || '"NO_CAR_FITS_SEATS"'::jsonb;
  end if;
  -- REQ §13.101 (a): large luggage needs a car with a large trunk.
  if coalesce((payload ->> 'has_luggage')::boolean, false) and not exists (
    select 1 from public.cars c where c.department_id = v_department_id and c.status = 'active' and 'large_trunk' = any(c.features)
  ) then
    v_warnings := v_warnings || '"NO_CAR_FITS_LUGGAGE"'::jsonb;
  end if;
  -- REQ §13.200: a towing request needs a car with the hitch.
  if coalesce((payload ->> 'needs_tow_hitch')::boolean, false) and not exists (
    select 1 from public.cars c where c.department_id = v_department_id and c.status = 'active' and 'tow_hitch' = any(c.features)
  ) then
    v_warnings := v_warnings || '"NO_CAR_FITS_TOW_HITCH"'::jsonb;
  end if;

  -- REQ §13.111 (a): a member's own placement choices may waive their large-trunk requirement: a quick / car-now
  -- request (payload `ask_small_trunk`) and ask-to-join (`join_ride_id`) refuse with needs_large_trunk when a car
  -- without a large trunk would be the only way to place them, unless the payload carries `allow_small_trunk`.
  -- Plain submits (no flag) and the automatic placement stay strict.
  v_allow_small := coalesce((payload ->> 'allow_small_trunk')::boolean, false);
  v_ask_small := v_allow_small or coalesce((payload ->> 'ask_small_trunk')::boolean, false) or v_join_ride_id is not null;
  if v_join_ride_id is not null and (public.request_needs_large_trunk(v_request_id) or public.request_needs_tow_hitch(v_request_id)) then
    select r.car_id into v_join_car from public.rides r where r.id = v_join_ride_id;
    if v_join_car is not null and not public.car_meets_needs(v_join_car,
         case when public.request_needs_large_trunk(v_request_id) then 1 else 0 end,
         case when public.request_needs_tow_hitch(v_request_id) then 1 else 0 end) then
      if not v_allow_small then
        raise exception 'needs_large_trunk' using errcode = 'P0001', detail = public._small_trunk_detail(array[v_request_id], v_join_car);
      end if;
      update public.requests set luggage_waived_at = now(), luggage_waived_by = v_actor where id = v_request_id;
    end if;
  end if;

  -- "Ask to join" a temporary car: create + send the merge proposal straight to the owner (REQ §13.43).
  if v_join_ride_id is not null then
    select c.type, c.owner_id into v_join_car_type, v_join_owner
    from public.rides r join public.cars c on c.id = r.car_id where r.id = v_join_ride_id;
    if v_join_car_type = 'temporary' then
      perform public.create_proposal(v_request_id, v_join_ride_id, 'merge',
        jsonb_build_object('ride_id', v_join_ride_id, 'legs', jsonb_build_array(
          jsonb_build_object('leg', 'both', 'ride_id', v_join_ride_id, 'car_mode', 'passenger'))),
        'ASK_TO_JOIN_TEMP_CAR', array[v_join_owner], 'ask_to_join');
    end if;
  end if;

  -- REQ §13.135 (c): a private car chosen in the form takes the round trip at once, in any week phase (never another
  -- car instead); a busy car refuses the submit so the member can pick other times.
  -- REQ §13.206: a one-way trip too - the ride ends after the route time and leaves the car at the destination, so
  -- both ends must be list places (place_request_on_car then also checks the car stands at the origin).
  if v_preferred_car_id is not null and v_trip_type in ('round_trip', 'one_way') and v_series_id is null and v_join_ride_id is null
     and coalesce((payload->>'reserve_missing_driver')::boolean, false) = false
     and exists (select 1 from public.cars c join public.requests q on q.id = v_request_id
                 where c.id = v_preferred_car_id and c.type = 'temporary' and c.status = 'active'
                   and (public.is_car_owner(c.id, v_actor) or public.is_car_owner(c.id, q.requester_id) or public.is_car_owner(c.id, q.filed_by))) then
    v_own_car := v_preferred_car_id;
    if v_depart_at < now() then raise exception 'ride_in_past' using errcode = 'P0001'; end if;
    v_own_turnaround := coalesce(public.required_turnaround_minutes(v_department_id, v_week_start), 30);
    v_own_end := v_return_at;
    if v_trip_type = 'one_way' then
      if v_depart_at is null or exists (select 1 from public.requests q where q.id = v_request_id
                                         and (q.origin_id is null or q.destination_id is null)) then
        raise exception 'own_car_one_way_place' using errcode = 'P0001';
      end if;
      v_own_end := greatest(public._round_up_ride_end(v_depart_at,
        v_depart_at + make_interval(mins => greatest(coalesce(public.request_leg_route_minutes(v_request_id, 'out'), 30), 0))),
        v_depart_at + interval '15 minutes');
    end if;
    if exists (select 1 from public.rides r where r.car_id = v_own_car and r.status <> 'cancelled'
               and not exists (select 1 from public.ride_requests rr where rr.ride_id = r.id and rr.request_id = v_request_id)
               and tstzrange(r.starts_at, r.blocked_until, '[)') && tstzrange(v_depart_at, v_own_end + make_interval(mins => v_own_turnaround), '[)'))
       or exists (select 1 from public.car_maintenance_blocks b where b.car_id = v_own_car
               and tstzrange(b.starts_at, b.ends_at, '[)') && tstzrange(v_depart_at, v_own_end, '[)')) then
      raise exception 'own_car_not_free' using errcode = 'P0001';
    end if;
  end if;

  -- Placement on submit (REQ §13.93/§13.94): only round_trip and an explicit one_way ("I take the
  -- car") go through try_auto_approve() once a week is published/live. Every drop_off, with or
  -- without a pickup, is two separate trips for the Sadran/solver: waitlisted in a live week.
  -- REQ §13.176 (owner 2026-11-01): an overlap with the member's own ride or request is a question - for whoever files
  -- it, the member or someone on their behalf - never a quiet trip to the waiting list for the Sadran. Confirmed
  -- (`overlap_confirmed`), the request is placed like any other. Inside an edit's trial placement nobody is asked yet:
  -- the trial notes it (`overlap_unasked`) and the edit asks only when the new hours would really be placed.
  if v_own_overlap and not v_overlap_confirmed
     and v_week.phase in ('published', 'live') and v_trip_type in ('round_trip', 'one_way') then
    if coalesce(current_setting('app.edit_probe_inner', true), 'off') = 'on' then
      v_overlap_unasked := true;
    else
      perform public._ask_request_overlap(v_requester_id, v_depart_at, v_return_at, v_request_id);
    end if;
  end if;
  if coalesce((payload->>'reserve_missing_driver')::boolean,false) then
    v_auto_result:=public.reserve_live_one_way_slot(v_request_id);
    perform public.enqueue_notification(s.profile_id,'waitlisted_request',v_department_id,v_week_start,
      jsonb_build_object('requestId',v_request_id::text),jsonb_build_object('request_id',v_request_id,'ride_id',v_auto_result->>'ride_id'),
      format('waitlisted_request:%s',v_request_id)) from public.sadranim_of(v_department_id,v_week_start) as s(profile_id)
    where coalesce(current_setting('app.late_request_notice', true), 'off') <> 'on';
  elsif v_own_car is not null then
    -- REQ §13.135 (c): on the chosen private car (pending proposals of the request are settled like place_on_own_car).
    perform set_config('app.audit_reason', 'own_car_from_form', true);
    update public.proposals p set status = 'withdrawn'
    where p.status in ('draft', 'sent')
      and (p.request_id = v_request_id or exists (select 1 from public.proposal_parties pp where pp.proposal_id = p.id and pp.request_id = v_request_id));
    v_edit_prev_sys := coalesce(nullif(current_setting('app.system_status_transition', true), ''), 'off');
    perform set_config('app.system_status_transition', 'on', true);
    v_edit_ride := public.place_request_on_car(v_request_id, v_own_car, false, v_actor, null, null, null, 'OWN_CAR');
    perform set_config('app.system_status_transition', v_edit_prev_sys, true);
    v_auto_result := jsonb_build_object('status', 'assigned', 'reason', 'OWN_CAR', 'ride_id', v_edit_ride, 'car_id', v_own_car);
    select full_name into v_own_by from public.profiles where id = v_actor;
    perform public.enqueue_notification(s.profile_id, 'outcome_changed', v_department_id, v_week_start,
      jsonb_build_object('byName', coalesce(v_own_by, ''), 'route', coalesce(public.request_route_label(v_request_id), ''),
        'day', public.day_date_label(v_depart_at), 'car', (select name from public.cars where id = v_own_car)),
      jsonb_build_object('variant', 'own_car_placed', 'request_id', v_request_id, 'ride_id', v_edit_ride,
        'url', format('/sadran/%s/%s/board', v_department_id, v_week_start)),
      format('own_car_placed:%s:%s:%s', v_request_id, s.profile_id, clock_timestamp()))
    from public.sadranim_of(v_department_id, v_week_start) as s(profile_id)
    where s.profile_id is distinct from v_actor and v_week.phase in ('published', 'live');
  elsif v_series_id is not null then
    -- REQ §13.77: placement is all-or-nothing across every leg — try_auto_approve_series()
    -- is called once by submit_series_request() after the last leg exists.
    v_auto_result := null;
  elsif v_join_ride_id is not null and v_week.phase in ('published', 'live') then
    -- R3B10: the member asked for THIS ride; no other car is ever picked for them.
    if v_week.phase = 'live' then
      perform set_config('app.system_status_transition', 'on', true);
      update public.requests set status = 'waitlisted', status_reason = 'ASK_TO_JOIN' where id = v_request_id;
      perform set_config('app.system_status_transition', 'off', true);
    end if;
    if v_join_car_type is distinct from 'temporary' then
      perform public.enqueue_notification(s.profile_id, 'waitlisted_request', v_department_id, v_week_start,
        jsonb_build_object('requestId', v_request_id::text, 'rideLabel', public._ask_to_join_ride_label(v_join_ride_id)),
        jsonb_build_object('request_id', v_request_id, 'variant', 'ask_to_join'),
        format('waitlisted_request:%s', v_request_id))
      from public.sadranim_of(v_department_id, v_week_start) as s(profile_id)
      where coalesce(current_setting('app.late_request_notice', true), 'off') <> 'on';
    end if;
    v_auto_result := jsonb_build_object('status', case when v_week.phase = 'live' then 'waitlisted' else 'submitted' end,
      'reason', 'ASK_TO_JOIN');
  elsif v_week.phase in ('published','live')
    and v_trip_type in ('round_trip', 'one_way') then
    -- REQ §13.111 (a): the strict placement (it already prefers a large-trunk car) is tried first; only when it finds
    -- no car and a car without a large trunk would take the request is the member asked ("לשבץ בכל זאת?").
    if v_ask_small and (public.request_needs_large_trunk(v_request_id) or public.request_needs_tow_hitch(v_request_id)) then
      v_small_car := public._small_trunk_probe(v_request_id);
      if v_small_car is not null then
        if not v_allow_small then
          raise exception 'needs_large_trunk' using errcode = 'P0001', detail = public._small_trunk_detail(array[v_request_id], v_small_car);
        end if;
        update public.requests set luggage_waived_at = now(), luggage_waived_by = v_actor where id = v_request_id;
        v_waived_here := true;
      end if;
    end if;
    -- REQ §13.127 (c): an edited round trip that was booked on a private car goes back on that car when it still
    -- fits (try_auto_approve only knows shared cars); place_request_on_car checks the owner's consent.
    -- REQ §13.206: so does a one-way trip.
    if v_published_edit and v_old_edit_car is not null
       and exists (select 1 from public.cars c where c.id = v_old_edit_car and c.type = 'temporary') then
      v_edit_prev_sys := coalesce(nullif(current_setting('app.system_status_transition', true), ''), 'off');
      perform set_config('app.system_status_transition', 'on', true);
      begin
        v_edit_ride := public.place_request_on_car(v_request_id, v_old_edit_car, false, v_actor, null, null, null, 'OWN_CAR');
      exception when others then
        v_edit_ride := null;
      end;
      perform set_config('app.system_status_transition', v_edit_prev_sys, true);
      if v_edit_ride is not null then
        v_auto_result := jsonb_build_object('status', 'assigned', 'reason', 'OWN_CAR', 'ride_id', v_edit_ride, 'car_id', v_old_edit_car);
      end if;
    end if;
    if v_auto_result is null then
      -- REQ §13.211: a NEW one-way request that no car takes only because the trip would leave the car at the
      -- destination asks the member (`car_stays_away`, nothing is filed; the form opts in with `car_away_ask`) and is
      -- placed once they said yes (`allow_car_away`). A "no" files it the usual way, to wait for the Sadran.
      if v_trip_type = 'one_way' and (payload ->> 'request_id') is null and coalesce((payload ->> 'allow_car_away')::boolean, false) then
        perform set_config('app.car_stays_away', 'any', true);
      end if;
      v_auto_result := public.try_auto_approve(v_request_id);
      perform set_config('app.car_stays_away', '', true);
      if v_trip_type = 'one_way' and (payload ->> 'request_id') is null and coalesce(v_auto_result ->> 'status', '') <> 'assigned'
         and coalesce((payload ->> 'car_away_ask')::boolean, false) and not coalesce((payload ->> 'allow_car_away')::boolean, false) then
        begin
          perform set_config('app.car_stays_away', 'any', true);
          perform set_config('app.system_status_transition', 'on', true);
          update public.requests set status = 'submitted', status_reason = null where id = v_request_id;
          v_probe_away := public.try_auto_approve(v_request_id);
          raise exception 'release_probe_rollback' using errcode = 'PXRP1';
        exception when sqlstate 'PXRP1' then
          null;
        end;
        perform set_config('app.car_stays_away', '', true);
        if coalesce(v_probe_away ->> 'status', '') = 'assigned' then
          v_away_car := (v_probe_away ->> 'car_id')::uuid;
          raise exception 'car_stays_away' using errcode = 'P0001', detail = jsonb_build_object(
            'car_name', (select c.name from public.cars c where c.id = v_away_car),
            'next_ride', public.car_next_ride_origin(v_away_car, v_depart_at) is not null)::text;
        end if;
      end if;
    end if;
    if v_waived_here and coalesce(v_auto_result ->> 'status', '') <> 'assigned' then
      update public.requests set luggage_waived_at = null, luggage_waived_by = null where id = v_request_id;
    end if;
  elsif v_week.phase in ('published', 'live') and v_trip_type = 'drop_off' and v_keep_car and v_series_id is null then
    -- REQ §13.126 g: both legs on ONE car, connected (assert_car_chain → connect_drop_off_legs keeps the car waiting at the
    -- destination for a keep-car request); the old booking's car first, then the preferred one. None takes both legs on
    -- one car -> the waiting list (block below).
    v_edit_ride := null;
    v_edit_prev_sys := coalesce(nullif(current_setting('app.system_status_transition', true), ''), 'off');
    perform set_config('app.system_status_transition', 'on', true);
    for v_keep_car_id in
      select c.id from public.cars c
      where c.department_id = v_department_id and c.status = 'active' and c.type = 'shared'
      order by (c.id = v_old_edit_car) desc nulls last, (c.id = v_preferred_car_id) desc nulls last, c.id
    loop
      begin
        v_edit_ride := public.place_request_on_car(v_request_id, v_keep_car_id, false, v_actor, null, null, null, 'AUTO_APPROVED_FREE_CAR');
        if coalesce(array_length(public.request_covered_legs(v_request_id), 1), 0) < 2
           or exists (select 1 from public.ride_requests rr join public.rides r on r.id = rr.ride_id
                      where rr.request_id = v_request_id and r.status <> 'cancelled' and r.car_id <> v_keep_car_id) then
          raise exception 'keep_car_both_legs' using errcode = 'PXKC1';
        end if;
        exit;
      exception when others then
        v_edit_ride := null;
      end;
    end loop;
    perform set_config('app.system_status_transition', v_edit_prev_sys, true);
    if v_edit_ride is not null then
      v_auto_result := jsonb_build_object('status', 'assigned', 'reason', 'AUTO_APPROVED_FREE_CAR', 'ride_id', v_edit_ride, 'car_id', v_keep_car_id);
    else
      perform set_config('app.system_status_transition', 'on', true);
      update public.requests set status = 'waitlisted', status_reason = 'WAITLISTED_NO_CAR' where id = v_request_id;
      perform set_config('app.system_status_transition', v_edit_prev_sys, true);
      v_auto_result := jsonb_build_object('status', 'waitlisted', 'reason', 'WAITLISTED_NO_CAR');
    end if;
  elsif v_published_edit and v_trip_type = 'drop_off' then
    -- Owner 2026-10-11: a member's edit into (or of) a הקפצה on a published/live day is placed when a car
    -- is free — the old booking's car first, then any free shared car — like the Sadran's trip-type switch
    -- (R8B12, REQ §13.117). Only when no car takes it does it go to the waiting list (block below).
    v_edit_ride := null;
    -- place_request_on_car moves the member's own request to `assigned` — a system step (requests_status_guard).
    v_edit_prev_sys := coalesce(nullif(current_setting('app.system_status_transition', true), ''), 'off');
    perform set_config('app.system_status_transition', 'on', true);
    if v_old_edit_car is not null then
      begin
        v_edit_ride := public.place_request_on_car(v_request_id, v_old_edit_car, false, v_actor, null, null, null, 'AUTO_APPROVED_FREE_CAR');
      exception when others then
        v_edit_ride := null;
      end;
    end if;
    if v_edit_ride is null then
      v_edit_ride := public.place_request_on_any_free_car(v_request_id, v_actor, null, null, 'AUTO_APPROVED_FREE_CAR');
    end if;
    perform set_config('app.system_status_transition', v_edit_prev_sys, true);
    if v_edit_ride is not null then
      v_auto_result := jsonb_build_object('status', 'assigned', 'reason', 'AUTO_APPROVED_FREE_CAR', 'ride_id', v_edit_ride,
        'car_id', (select car_id from public.rides where id = v_edit_ride));
    end if;
  elsif v_week.phase in ('published', 'live') and v_trip_type = 'drop_off' and v_request_id is not null
    and public.is_day_public(v_department_id, v_week_start, (coalesce(v_depart_at, v_return_at) at time zone 'Asia/Jerusalem')::date)
    and public.place_request_on_any_free_car_as_system(v_request_id, v_actor) is not null then
    -- REQ §13.192 (HK1, owner 2026-11-07): a NEW הקפצה on a published day is placed like an edit into one (owner
    -- 2026-10-11): on a free shared car, else the waiting list (the branch below). A ride nobody drives yet is
    -- `needs_driver` (the request waits as UNMET_NEEDS_DRIVER) and the driver-wanted flow (REQ §13.170) finds one.
    select r.id, r.car_id, coalesce(bool_or(r.needs_driver) over (), false) into v_edit_ride, v_keep_car_id, v_needs_driver
    from public.ride_requests rr join public.rides r on r.id = rr.ride_id
    where rr.request_id = v_request_id and r.status <> 'cancelled' order by r.starts_at, r.id limit 1;
    if v_needs_driver then
      v_auto_result := jsonb_build_object('status', 'waitlisted', 'reason', 'UNMET_NEEDS_DRIVER', 'needs_driver', true,
        'ride_id', v_edit_ride, 'car_id', v_keep_car_id);
      perform public.enqueue_notification(s.profile_id, 'waitlisted_request', v_department_id, v_week_start,
        jsonb_build_object('requestId', v_request_id::text), jsonb_build_object('request_id', v_request_id, 'ride_id', v_edit_ride),
        format('waitlisted_request:%s', v_request_id))
      from public.sadranim_of(v_department_id, v_week_start) as s(profile_id)
      where coalesce(current_setting('app.late_request_notice', true), 'off') <> 'on'
        and s.profile_id is distinct from v_actor;
    else
      v_auto_result := jsonb_build_object('status', 'assigned', 'reason', 'AUTO_APPROVED_FREE_CAR', 'needs_driver', false,
        'ride_id', v_edit_ride, 'car_id', v_keep_car_id);
    end if;
  elsif v_week.phase = 'live' then
    perform set_config('app.system_status_transition', 'on', true);
    update public.requests set status = 'waitlisted', status_reason = 'WAITLISTED_ONE_WAY' where id = v_request_id;
    perform set_config('app.system_status_transition', 'off', true);
    perform public.enqueue_notification(s.profile_id, 'waitlisted_request', v_department_id, v_week_start,
      jsonb_build_object('requestId', v_request_id::text), jsonb_build_object('request_id', v_request_id),
      format('waitlisted_request:%s', v_request_id))
    from public.sadranim_of(v_department_id, v_week_start) as s(profile_id)
    where coalesce(current_setting('app.late_request_notice', true), 'off') <> 'on';
    v_auto_result := jsonb_build_object('status', 'waitlisted', 'reason', 'WAITLISTED_ONE_WAY');
  end if;

  -- REQ §13.101 (f): an edited request on a published/live day that found no car goes to the waiting list.
  if v_published_edit and v_request_id is not null and coalesce(v_auto_result ->> 'status', '') <> 'assigned' then
    select status into v_status from public.requests where id = v_request_id;
    if v_status is distinct from 'waitlisted' then
      perform set_config('app.system_status_transition', 'on', true);
      update public.requests set status = 'waitlisted', status_reason = 'WAITLISTED_EDITED' where id = v_request_id;
      perform set_config('app.system_status_transition', 'off', true);
      -- R2Q1: an edited request joins an open overlapping group exactly like a late one.
      if public.join_waitlist_group(v_request_id) is not null then
        v_auto_result := coalesce(v_auto_result, '{}'::jsonb) || jsonb_build_object('reason', 'WAITLISTED_CONTESTED');
      end if;
      perform public.enqueue_notification(s.profile_id, 'waitlisted_request', v_department_id, v_week_start,
        jsonb_build_object('requestId', v_request_id::text), jsonb_build_object('request_id', v_request_id),
        format('waitlisted_request:%s', v_request_id))
      from public.sadranim_of(v_department_id, v_week_start) as s(profile_id)
    where coalesce(current_setting('app.late_request_notice', true), 'off') <> 'on'
      and s.profile_id is distinct from (select auth.uid());
      v_auto_result := coalesce(v_auto_result, '{}'::jsonb)
        || jsonb_build_object('status', 'waitlisted', 'reason', coalesce(v_auto_result ->> 'reason', 'WAITLISTED_EDITED'));
    end if;
    -- R6B13: the editor is told the edit was saved and the request now waits (nothing was said before).
    -- REQ §13.169 (c): a requester who did not make the form's edit gets the riders' `ride_edited` notice instead.
    if not v_form_notice or v_requester_id = v_actor then
    perform public.enqueue_notification(v_requester_id, 'outcome_changed', v_department_id, v_week_start,
      '{}'::jsonb, jsonb_build_object('variant', 'edit_waitlisted', 'request_id', v_request_id),
      format('edit_waitlisted:%s:%s', v_request_id, clock_timestamp()));
    end if;
  end if;

  if v_is_late and coalesce(v_auto_result->>'status','') <> 'assigned' and coalesce(v_series_index, 1) = 1 then
    v_late_variant := case coalesce(v_auto_result->>'reason', '')
      when 'WAITLISTED_CONTESTED' then 'late_contested'
      when 'DUPLICATE_OVERLAP' then 'late_duplicate'
      when 'WAITLISTED_NO_CAR' then 'late_waitlisted'
      else case when coalesce(v_auto_result->>'status', '') = 'waitlisted' then 'late_waitlisted' else null end end;
    -- R5U5: a late ask-to-join is an ask-to-join (naming the ride asked), not a plain late request.
    if v_join_ride_id is not null then v_late_variant := 'ask_to_join'; end if;
    perform public.enqueue_notification(s.profile_id, 'late_request', v_department_id, v_week_start,
      jsonb_build_object('requestId', v_request_id::text)
        || case when v_join_ride_id is not null then jsonb_build_object('rideLabel', public._ask_to_join_ride_label(v_join_ride_id)) else '{}'::jsonb end,
      jsonb_build_object('request_id', v_request_id) || case when v_late_variant is null then '{}'::jsonb else jsonb_build_object('variant', v_late_variant) end,
      format('late_request:%s', v_request_id))
    from public.sadranim_of(v_department_id, v_week_start) as s(profile_id)
    -- R13B15: the Sadran who made the change is not told about it.
    where s.profile_id is distinct from (select auth.uid());
  end if;
  perform set_config('app.late_request_notice', 'off', true);

  -- R2B20: a post-publish edit that was placed straight away is confirmed to the member.
  perform set_config('app.edit_prefer_car', '', true);
  perform set_config('app.car_stays_away', '', true);
  perform set_config('app.edit_kept_rides', '', true);
  if v_published_edit and coalesce(v_auto_result->>'status', '') = 'assigned' then
    -- R3B14: when the car changed, the confirmation says old -> new including the car.
    -- REQ §13.169 (c): only to a requester who made the form's edit themselves; the other riders get `ride_edited`.
    if v_form_notice and v_requester_id is distinct from v_actor then
      null;
    elsif v_old_edit_car is not null and (v_auto_result->>'car_id') is not null and (v_auto_result->>'car_id')::uuid <> v_old_edit_car then
      perform public.enqueue_notification(v_requester_id, 'outcome_changed', v_department_id, v_week_start,
        jsonb_build_object('changeLine', public._frag('change.car', jsonb_build_object(
          'newCar', coalesce((select name from public.cars where id = (v_auto_result->>'car_id')::uuid), ''),
          'oldCar', coalesce((select name from public.cars where id = v_old_edit_car), '')))),
        jsonb_build_object('variant', 'car_changed', 'request_id', v_request_id, 'ride_id', v_auto_result->>'ride_id'),
        format('edit_applied:%s:%s', v_request_id, clock_timestamp()));
    else
      perform public.enqueue_notification(v_requester_id, 'outcome_changed', v_department_id, v_week_start,
        '{}'::jsonb, jsonb_build_object('variant', 'edit_applied', 'request_id', v_request_id, 'ride_id', v_auto_result->>'ride_id'),
        format('edit_applied:%s:%s', v_request_id, clock_timestamp()));
    end if;
    -- R16B12: the member companions ride at the new hours too - each is told (never the person who edited).
    -- REQ §13.169 (c): a save from the request form tells them with `ride_edited` instead.
    if not v_form_notice and (v_existing.depart_at, v_existing.return_at) is distinct from (v_depart_at, v_return_at) then
      for v_companion in select c.profile_id from public.request_companions c
                         where c.request_id = v_request_id and c.profile_id is distinct from v_actor loop
        perform public.enqueue_notification(v_companion, 'outcome_changed', v_department_id, v_week_start,
          jsonb_build_object('byName', coalesce((select full_name from public.profiles where id = v_requester_id), ''),
            'route', coalesce(public.request_route_label(v_request_id), ''),
            'day', public.day_date_label(coalesce(v_existing.depart_at, v_existing.return_at)),
            'timeChange', public._time_change_line(v_existing.depart_at, v_existing.return_at, v_depart_at, v_return_at),
            'carLine', ''),
          jsonb_build_object('variant', 'time_changed', 'request_id', v_request_id, 'ride_id', v_auto_result->>'ride_id'),
          format('companion_time_changed:%s:%s:%s', v_request_id, v_companion, clock_timestamp()));
      end loop;
    end if;
  end if;

  -- R14B8: /my reads submitted until the day is published (REQ §13.109 a), so a member's form must not announce
  -- "you got car X" for it: the result keeps its fields (tests, the Sadran) and says `outcome_hidden`; the form then
  -- shows the plain "request sent" confirmation.
  if not coalesce(v_can_manage, false) and v_auto_result ? 'status'
     and v_auto_result->>'status' in ('assigned', 'merged', 'waitlisted', 'denied', 'external')
     and not public.is_day_public(v_department_id, v_week_start,
       (coalesce(v_depart_at, v_return_at) at time zone 'Asia/Jerusalem')::date) then
    v_auto_result := v_auto_result || jsonb_build_object('outcome_hidden', true);
  end if;

  return jsonb_build_object('request_id', v_request_id, 'is_late', v_is_late, 'warnings', v_warnings, 'overlaps', v_overlaps)
    || case when v_overlap_unasked then jsonb_build_object('overlap_unasked', true) else '{}'::jsonb end
    || coalesce(v_auto_result, '{}'::jsonb);
end;
$function$;

-- Policies: an owner = the car is in my_owned_car_ids() (TEST 20: the set form, once per query).
drop policy cars_update on public.cars;
create policy cars_update on public.cars for update to authenticated
  using ((select public.is_admin()) or department_id in (select d from public.my_sadran_department_ids() d)
         or (type = 'temporary' and id in (select o from public.my_owned_car_ids() o)))
  with check ((select public.is_admin()) or department_id in (select d from public.my_sadran_department_ids() d)
         or (type = 'temporary' and id in (select o from public.my_owned_car_ids() o)));

drop policy cars_delete on public.cars;
create policy cars_delete on public.cars for delete to authenticated
  using ((select public.is_admin()) or department_id in (select d from public.my_sadran_department_ids() d)
         or (type = 'temporary' and id in (select o from public.my_owned_car_ids() o)
             and not exists (select 1 from public.rides r where r.car_id = cars.id and r.status <> 'cancelled')));


drop policy car_seat_configs_insert on public.car_seat_configs;
create policy car_seat_configs_insert on public.car_seat_configs for insert to authenticated
  with check ((select public.is_admin())
    or exists (select 1 from public.cars managed_car where managed_car.id = car_seat_configs.car_id
               and managed_car.department_id in (select d from public.my_sadran_department_ids() d))
    or exists (select 1 from public.cars c where c.id = car_seat_configs.car_id and c.type = 'temporary'
               and c.id in (select o from public.my_owned_car_ids() o)));

drop policy car_seat_configs_update on public.car_seat_configs;
create policy car_seat_configs_update on public.car_seat_configs for update to authenticated
  using ((select public.is_admin())
    or exists (select 1 from public.cars managed_car where managed_car.id = car_seat_configs.car_id
               and managed_car.department_id in (select d from public.my_sadran_department_ids() d))
    or exists (select 1 from public.cars c where c.id = car_seat_configs.car_id and c.type = 'temporary'
               and c.id in (select o from public.my_owned_car_ids() o)))
  with check ((select public.is_admin())
    or exists (select 1 from public.cars managed_car where managed_car.id = car_seat_configs.car_id
               and managed_car.department_id in (select d from public.my_sadran_department_ids() d))
    or exists (select 1 from public.cars c where c.id = car_seat_configs.car_id and c.type = 'temporary'
               and c.id in (select o from public.my_owned_car_ids() o)));

drop policy car_seat_configs_delete on public.car_seat_configs;
create policy car_seat_configs_delete on public.car_seat_configs for delete to authenticated
  using ((select public.is_admin())
    or exists (select 1 from public.cars managed_car where managed_car.id = car_seat_configs.car_id
               and managed_car.department_id in (select d from public.my_sadran_department_ids() d))
    or exists (select 1 from public.cars c where c.id = car_seat_configs.car_id and c.type = 'temporary'
               and c.id in (select o from public.my_owned_car_ids() o)));

