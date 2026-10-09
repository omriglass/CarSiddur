-- REQ §13.114 (owner 2026-10-09): scheduled car maintenance. A period = start + end (date and time, may span
-- days), set from a car issue (unsafe: start = now, end chosen) or from the car-details page; replaces the
-- "unavailable for X hours" action. Who may create / move / resize / remove one: an admin, the department's
-- Sadranim, and the car's CURRENT responsible person (`cars.responsible_id` is read at the moment of the call,
-- so a block created by someone else is still editable by whoever is responsible now). The table's own
-- policies are unchanged (admin / Sadran direct writes keep working for the admin screen); everyone else, the
-- responsible person included, goes through these RPCs, which re-check the rule server-side.
-- Rides already inside a new / extended period are flagged and notified by the existing
-- `flag_rides_in_maintenance` trigger (`maintenance_affects`); shrinking / removing a period clears stale
-- flags through `maintenance_refresh_flags`.

create or replace function public._can_edit_car_maintenance(p_car_id uuid) returns boolean
language sql stable security definer set search_path = public, pg_temp as $$
  select exists (
    select 1 from public.cars c
    where c.id = p_car_id
      and (public.is_admin()
        or (public.is_approved()
          and (public.can_manage_operations(c.department_id) or public.is_sadran_any(c.department_id)
            or c.responsible_id = (select auth.uid()))))
  );
$$;
revoke all on function public._can_edit_car_maintenance(uuid) from public;

-- Period snapping: start down, end up, to the quarter hour the table's CHECK constraints require.
create or replace function public._maintenance_quarter_floor(p_t timestamptz) returns timestamptz
language sql immutable as $$ select to_timestamp(floor(extract(epoch from p_t) / 900) * 900) $$;
create or replace function public._maintenance_quarter_ceil(p_t timestamptz) returns timestamptz
language sql immutable as $$ select to_timestamp(ceil(extract(epoch from p_t) / 900) * 900) $$;
revoke all on function public._maintenance_quarter_floor(timestamptz) from public;
revoke all on function public._maintenance_quarter_ceil(timestamptz) from public;

create or replace function public.create_car_maintenance(
  p_car_id uuid, p_starts_at timestamptz, p_ends_at timestamptz, p_reason text default null
) returns uuid
language plpgsql security definer set search_path = public, pg_temp as $$
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

create or replace function public.update_car_maintenance(
  p_block_id uuid, p_starts_at timestamptz, p_ends_at timestamptz
) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_old public.car_maintenance_blocks%rowtype; v_start timestamptz; v_end timestamptz; v_flagged int;
begin
  select * into v_old from public.car_maintenance_blocks where id = p_block_id for update;
  if v_old.id is null then raise exception 'maintenance_not_found' using errcode = 'P0001'; end if;
  if not public._can_edit_car_maintenance(v_old.car_id) then raise exception 'not_authorized' using errcode = 'P0001'; end if;
  if v_old.ends_at <= now() then raise exception 'maintenance_finished' using errcode = 'P0001'; end if;
  v_start := public._maintenance_quarter_floor(coalesce(p_starts_at, v_old.starts_at));
  v_end := public._maintenance_quarter_ceil(coalesce(p_ends_at, v_old.ends_at));
  if v_end <= v_start then raise exception 'invalid_maintenance_period' using errcode = 'P0001'; end if;
  if v_end <= now() then raise exception 'maintenance_in_past' using errcode = 'P0001'; end if;
  -- A period already running cannot be stretched back into the past.
  if v_start < v_old.starts_at and v_start < public._maintenance_quarter_floor(now()) then
    raise exception 'maintenance_in_past' using errcode = 'P0001';
  end if;
  if exists (select 1 from public.car_maintenance_blocks b
             where b.car_id = v_old.car_id and b.id <> v_old.id
               and tstzrange(b.starts_at, b.ends_at, '[)') && tstzrange(v_start, v_end, '[)')) then
    raise exception 'maintenance_overlap' using errcode = 'P0001';
  end if;
  perform set_config('app.audit_reason', 'update_car_maintenance', true);
  update public.car_maintenance_blocks set starts_at = v_start, ends_at = v_end where id = p_block_id;
  select count(*) into v_flagged from public.rides r
  where r.car_id = v_old.car_id and r.status <> 'cancelled' and r.flag_reason = 'maintenance'
    and tstzrange(r.starts_at, r.blocked_until, '[)') && tstzrange(v_start, v_end, '[)');
  return jsonb_build_object('id', p_block_id, 'starts_at', v_start, 'ends_at', v_end, 'flagged_rides', v_flagged);
end $$;

create or replace function public.delete_car_maintenance(p_block_id uuid) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_old public.car_maintenance_blocks%rowtype;
begin
  select * into v_old from public.car_maintenance_blocks where id = p_block_id for update;
  if v_old.id is null then raise exception 'maintenance_not_found' using errcode = 'P0001'; end if;
  if not public._can_edit_car_maintenance(v_old.car_id) then raise exception 'not_authorized' using errcode = 'P0001'; end if;
  perform set_config('app.audit_reason', 'delete_car_maintenance', true);
  delete from public.car_maintenance_blocks where id = p_block_id;
end $$;

-- From a car issue: start = now (snapped down), the end is chosen. Replaces the "X hours" shortcut.
create or replace function public.report_car_issue_unsafe_maintenance(p_issue_id uuid, p_ends_at timestamptz) returns uuid
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_issue record;
begin
  select * into v_issue from public.car_issues where id = p_issue_id;
  if v_issue is null then raise exception 'car_issue_not_found' using errcode = 'P0001'; end if;
  if not public._can_edit_car_maintenance(v_issue.car_id) then raise exception 'not_authorized' using errcode = 'P0001'; end if;
  return public.create_car_maintenance(v_issue.car_id, null, p_ends_at, 'UNSAFE_ISSUE');
end $$;

-- Legacy "X hours" entry point kept callable (old clients): now a thin wrapper. The old body inserted
-- `now()` unsnapped, which `car_maintenance_blocks_starts_qh_ck` refuses, and flipped `cars.status` to
-- 'maintenance' for good; the period itself blocks the car, so the status is left alone.
create or replace function public.report_car_issue_unsafe_to_maintenance(p_issue_id uuid, p_hours integer default 24) returns uuid
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  return public.report_car_issue_unsafe_maintenance(p_issue_id, now() + make_interval(hours => greatest(coalesce(p_hours, 24), 1)));
end $$;

revoke all on function public.create_car_maintenance(uuid, timestamptz, timestamptz, text) from public;
revoke all on function public.update_car_maintenance(uuid, timestamptz, timestamptz) from public;
revoke all on function public.delete_car_maintenance(uuid) from public;
revoke all on function public.report_car_issue_unsafe_maintenance(uuid, timestamptz) from public;
grant execute on function public.create_car_maintenance(uuid, timestamptz, timestamptz, text) to authenticated;
grant execute on function public.update_car_maintenance(uuid, timestamptz, timestamptz) to authenticated;
grant execute on function public.delete_car_maintenance(uuid) to authenticated;
grant execute on function public.report_car_issue_unsafe_maintenance(uuid, timestamptz) to authenticated;
