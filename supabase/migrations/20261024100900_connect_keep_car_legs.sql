-- Owner 2026-10-11 (REQ §13.126 g): a keep_car_at_destination request's two legs always connect on their car (the car
-- waits at the destination, open to trips that start and end there) — the REQ §13.103 a "wait needed elsewhere" test is
-- skipped for it. Full definition from schema-current.sql; the change is that one condition.

CREATE OR REPLACE FUNCTION "public"."connect_drop_off_legs"("_car" "uuid", "_week" "date") RETURNS "void"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
declare
  v_dept uuid; v_turnaround interval; c record; q public.requests%rowtype; v_driver uuid;
  v_os timestamptz; v_oe timestamptz; v_rs timestamptz; v_re timestamptz; v_gap smallint;
  v_t_out int; v_t_ret int; v_prev_flag text;
begin
  select department_id into v_dept from public.cars where id = _car;
  if v_dept is null then return; end if;
  v_turnaround := make_interval(mins => coalesce(public.required_turnaround_minutes(v_dept, _week), 30));

  for c in
    select o.request_id, o.ride_id as out_ride, rt.ride_id as ret_ride, (o.manual or rt.manual) as manual
    from (
      select rr.request_id, r.id as ride_id, rr.car_mode, (r.pin_reason = 'SADRAN_MANUAL') as manual
      from public.rides r join public.ride_requests rr on rr.ride_id = r.id
      where r.car_id = _car and r.week_start = _week and r.status <> 'cancelled' and not r.planning_conflict
        and not r.auto_relocation and rr.leg = 'out'
        and (select count(*) from public.ride_requests x where x.ride_id = r.id) = 1
    ) o
    join (
      select rr.request_id, r.id as ride_id, rr.car_mode, (r.pin_reason = 'SADRAN_MANUAL') as manual
      from public.rides r join public.ride_requests rr on rr.ride_id = r.id
      where r.car_id = _car and r.week_start = _week and r.status <> 'cancelled' and not r.planning_conflict
        and not r.auto_relocation and rr.leg = 'return'
        and (select count(*) from public.ride_requests x where x.ride_id = r.id) = 1
    ) rt on rt.request_id = o.request_id
    join public.requests qq on qq.id = o.request_id
    where qq.trip_type = 'drop_off' and qq.trip_shape = 'round_trip'
      and qq.depart_at is not null and qq.return_at is not null
      and qq.origin_id is not null and qq.destination_id is not null
      and (o.car_mode <> 'relay' or rt.car_mode <> 'relay')
    order by qq.depart_at, o.request_id
  loop
    select * into q from public.requests where id = c.request_id;
    v_driver := public.eligible_leg_driver(q.id);
    if v_driver is null then continue; end if; -- a non-driver's legs stay chauffeur rides

    v_t_out := greatest(coalesce(public.request_leg_route_minutes(q.id, 'out'), 30), 0);
    v_t_ret := greatest(coalesce(public.request_leg_route_minutes(q.id, 'return'), 30), 0);
    v_os := q.depart_at;
    v_oe := greatest(public._round_up_ride_end(v_os, v_os + make_interval(mins => v_t_out)), v_os + interval '15 minutes');
    v_re := q.return_at;
    v_rs := to_timestamp(floor(extract(epoch from (v_re - make_interval(mins => v_t_ret))) / 900) * 900);
    if v_rs < v_oe then continue; end if;
    -- REQ §13.103 a / §13.104 a: the wait is needed by others -> two legs, the car returns. A Sadran's own
    -- (manual) placement of either leg is an explicit decision and is never undone by this rule (R4B2).
    -- R5B8 (REQ §13.105): a SHORT wait (<= 2 x turnaround, the §13.104 b threshold) never counts as needed elsewhere:
    -- two chauffeur wraps burn more car time than the wait and leave a member who can drive with two driverless rides.
    -- REQ §13.126 g: "the car is available at the destination" — the member keeps it waiting there on purpose
    -- (trips that start and end there may use it, below); the wait is never handed back for being needed elsewhere.
    if not c.manual and not q.keep_car_at_destination and v_rs - v_oe > 2 * v_turnaround
       and public.car_wait_needed_elsewhere(q.department_id, q.week_start, v_oe, v_rs, array[q.id]) then
      continue;
    end if;

    -- the car must be at the origin when the out leg leaves
    if coalesce((select r.destination_id from public.rides r
                 where r.car_id = _car and r.status <> 'cancelled' and r.starts_at <= v_os and r.id not in (c.out_ride, c.ret_ride)
                   and not public.ride_is_reservation(r.id)
                 order by r.starts_at desc limit 1), public.car_base_location(_car)) is distinct from q.origin_id then continue; end if;
    -- no collision with other rides of the car; between the legs only trips that start and end at the destination
    if exists (
      select 1 from public.rides x
      where x.car_id = _car and x.id not in (c.out_ride, c.ret_ride) and x.status <> 'cancelled' and not x.planning_conflict
        and (tstzrange(x.starts_at, x.blocked_until, '[)') && tstzrange(v_os, v_oe + v_turnaround, '[)')
          or tstzrange(x.starts_at, x.blocked_until, '[)') && tstzrange(v_rs, v_re + v_turnaround, '[)')
          or (x.starts_at >= v_oe and x.starts_at < v_rs
              and not public.ride_is_reservation(x.id)
              and (x.origin_id is distinct from q.destination_id or x.destination_id is distinct from q.destination_id)))
    ) then continue; end if;

    v_gap := case when v_rs - v_oe < v_turnaround then (extract(epoch from (v_rs - v_oe)) / 60)::smallint end;

    update public.rides set origin_id = q.origin_id, destination_id = q.destination_id,
      starts_at = v_os, ends_at = v_oe, needs_driver = false, driver_id = v_driver,
      turnaround_override_minutes = v_gap,
      pin_reason = case when pin_reason = 'MISSING_DRIVER' then 'CONNECTED_DROP_OFF' else pin_reason end
    where id = c.out_ride;
    update public.rides set origin_id = q.destination_id, destination_id = q.origin_id,
      starts_at = v_rs, ends_at = v_re, needs_driver = false, driver_id = v_driver,
      pin_reason = case when pin_reason = 'MISSING_DRIVER' then 'CONNECTED_DROP_OFF' else pin_reason end
    where id = c.ret_ride;
    update public.ride_requests set role = 'driver', car_mode = 'relay'
    where request_id = q.id and ride_id in (c.out_ride, c.ret_ride);

    v_prev_flag := coalesce(nullif(current_setting('app.system_status_transition', true), ''), 'off');
    perform set_config('app.system_status_transition', 'on', true);
    update public.requests set status = 'assigned', status_reason = 'RELAY_CONNECTED'
    where id = q.id and status is distinct from 'assigned';
    perform set_config('app.system_status_transition', v_prev_flag, true);
  end loop;
end $$;


ALTER FUNCTION "public"."connect_drop_off_legs"("_car" "uuid", "_week" "date") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."create_car_maintenance"("p_car_id" "uuid", "p_starts_at" timestamp with time zone, "p_ends_at" timestamp with time zone, "p_reason" "text" DEFAULT NULL::"text") RETURNS "uuid"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
declare
  v_dept uuid; v_start timestamptz; v_end timestamptz; v_id uuid; v_ms timestamptz; v_me timestamptz;
  v_reason text;
begin
  select department_id into v_dept from public.cars where id = p_car_id;
  if v_dept is null then raise exception 'car_not_found' using errcode = 'P0001'; end if;
  if not public._can_edit_car_maintenance(p_car_id) then raise exception 'not_authorized' using errcode = 'P0001'; end if;
  if p_ends_at is null then raise exception 'invalid_maintenance_period' using errcode = 'P0001'; end if;
  v_start := public._maintenance_quarter_floor(coalesce(p_starts_at, now()));
  v_end := public._maintenance_quarter_ceil(p_ends_at);
  if v_end <= v_start then raise exception 'invalid_maintenance_period' using errcode = 'P0001'; end if;
  if v_end <= now() then raise exception 'maintenance_in_past' using errcode = 'P0001'; end if;
  v_reason := left(coalesce(nullif(btrim(p_reason), ''), 'SCHEDULED'), 200);
  perform set_config('app.audit_reason', 'create_car_maintenance', true);

  -- A period overlapping an existing one of the same car joins it (one band per car, never stacked).
  select b.id into v_id from public.car_maintenance_blocks b
  where b.car_id = p_car_id and tstzrange(b.starts_at, b.ends_at, '[)') && tstzrange(v_start, v_end, '[)')
  order by b.starts_at, b.id limit 1;
  if v_id is not null then
    select least(min(b.starts_at), v_start), greatest(max(b.ends_at), v_end) into v_ms, v_me
    from public.car_maintenance_blocks b
    where b.car_id = p_car_id and tstzrange(b.starts_at, b.ends_at, '[)') && tstzrange(v_start, v_end, '[)');
    update public.car_maintenance_blocks set starts_at = v_ms, ends_at = v_me where id = v_id;
    delete from public.car_maintenance_blocks b
    where b.car_id = p_car_id and b.id <> v_id and tstzrange(b.starts_at, b.ends_at, '[)') && tstzrange(v_ms, v_me, '[)');
    return v_id;
  end if;

  insert into public.car_maintenance_blocks (car_id, department_id, starts_at, ends_at, reason, created_by)
  values (p_car_id, v_dept, v_start, v_end, v_reason, (select auth.uid()))
  returning id into v_id;
  return v_id;
end $$;


ALTER FUNCTION "public"."create_car_maintenance"("p_car_id" "uuid", "p_starts_at" timestamp with time zone, "p_ends_at" timestamp with time zone, "p_reason" "text") OWNER TO "postgres";

SET default_tablespace = '';

SET default_table_access_method = "heap";


CREATE TABLE IF NOT EXISTS "public"."departments" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "name" "text" NOT NULL,
    "slug" "text" NOT NULL,
    "is_active" boolean DEFAULT true NOT NULL,
    "home_destination_id" "uuid",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "departments_slug_format" CHECK (("slug" ~ '^[a-z0-9-]+$'::"text"))
);

ALTER TABLE ONLY "public"."departments" FORCE ROW LEVEL SECURITY;


ALTER TABLE "public"."departments" OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."create_department"("p_name" "text", "p_slug" "text", "p_source_department_id" "uuid" DEFAULT NULL::"uuid") RETURNS "public"."departments"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
declare d public.departments;
begin
  if not public.is_admin() then raise exception 'not_authorized' using errcode='P0001'; end if;
  insert into public.departments(name,slug) values(p_name,p_slug) returning * into d;
  if p_source_department_id is not null then perform public.initialize_department_catalogs(d.id,p_source_department_id); end if;
  select * into d from public.departments where id=d.id;
  return d;
end $$;


ALTER FUNCTION "public"."create_department"("p_name" "text", "p_slug" "text", "p_source_department_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."create_policy_version"("p_policy_id" "uuid", "p_rules" "jsonb", "p_note" "text" DEFAULT NULL::"text", "p_settings" "jsonb" DEFAULT '{}'::"jsonb") RETURNS "uuid"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
declare v_version_id uuid;
begin
  if not exists (select 1 from public.policies p where p.id = p_policy_id and public.can_manage_operations(p.department_id)) then raise exception 'not_authorized' using errcode = 'P0001'; end if;
  perform set_config('app.audit_reason', 'create_policy_version', true);
  insert into public.policy_versions (policy_id, rules, note, settings, created_by)
  values (p_policy_id, p_rules, p_note, coalesce(p_settings, '{}'::jsonb), (select auth.uid()))
  returning id into v_version_id;
  update public.policies set current_version_id = v_version_id where id = p_policy_id;
  return v_version_id;
end;
$$;
