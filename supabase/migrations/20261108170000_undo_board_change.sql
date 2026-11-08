-- TODO UN1 (owner 2026-11-08): every board action can be undone. Each board action is one RPC = one transaction, and
-- every row it changes in the board's tables is in `audit_log` with its full before/after. So one generic inverse
-- serves every action — drag, unassign, cancel (series included), merge/unmerge, driver, passengers, trip type, plan,
-- car move, car swap, join legs, close/withdraw-duplicate, drafts, auto-fill: `undo_board_change` replays one
-- transaction's audit rows in reverse. The restored rows are the same rows (same ids), so the board's held notices
-- net out at "send all" (`_flush_held_notices` compares with the current state).
--
-- * `audit_log.txid` (new, set by `audit_row`) groups one transaction's rows.
-- * `board_changes_since(dept, week, after)`: a marker before an action, the action's transactions after it (the
--   board keeps them as the undo entry).
-- * `undo_board_change(dept, week, txids)`: refuses when the transaction is not the caller's own, touched a table
--   outside the board's (publish = `siddur_versions`, settings, …), notified someone at once (sending is final, owner
--   2026-11-08), or any of its rows changed since (`undo_stale`); otherwise reverses it and returns its own txid —
--   undoing that is the redo.

alter table public.audit_log add column if not exists txid bigint;

-- The transaction an audit row belongs to. `app.audit_txid` lets a transactional SQL suite simulate separate board
-- requests inside its one transaction (like `app.held_audit_floor`); the browser cannot set it.
create or replace function public._audit_txid() returns bigint
  language sql volatile set search_path = public, pg_temp as $$
  select coalesce(nullif(current_setting('app.audit_txid', true), '')::bigint, txid_current());
$$;
revoke all on function public._audit_txid() from public, anon;
create index if not exists audit_log_txid_idx on public.audit_log (txid) where txid is not null;
create index if not exists audit_log_actor_txid_idx on public.audit_log (actor_id, id desc) where txid is not null;

create or replace function public.audit_row() returns trigger
  language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_before jsonb;
  v_after jsonb;
  v_row jsonb;
  v_changed text[];
  v_subject uuid;
  v_dept uuid;
  v_week date;
  v_row_id text;
  v_actor_role public.role;
begin
  if tg_op = 'DELETE' then
    v_before := to_jsonb(old) - 'phone';
    v_row := to_jsonb(old);
  else
    v_after := to_jsonb(new) - 'phone';
    v_row := to_jsonb(new);
    if tg_op = 'UPDATE' then
      v_before := to_jsonb(old) - 'phone';
      select array_agg(n.key) into v_changed
      from jsonb_each(to_jsonb(new)) n
      where n.value is distinct from (to_jsonb(old) -> n.key);
    end if;
  end if;

  v_dept := nullif(v_row ->> 'department_id', '')::uuid;
  v_week := nullif(v_row ->> 'week_start', '')::date;
  v_row_id := coalesce(
    v_row ->> 'id',
    case when v_row ? 'department_id' and v_row ? 'week_start'
      then (v_row ->> 'department_id') || '|' || (v_row ->> 'week_start') end,
    v_row ->> 'department_id',
    case when v_row ? 'ride_id' and v_row ? 'request_id'
      then (v_row ->> 'ride_id') || '|' || (v_row ->> 'request_id') || '|' || coalesce(v_row ->> 'leg', '') end,
    v_row ->> 'profile_id'
  );

  v_subject := case tg_table_name
    when 'ride_change_requests' then (v_row ->> 'requester_id')::uuid
    when 'ride_change_parties' then (v_row ->> 'profile_id')::uuid
    when 'requests' then (v_row ->> 'requester_id')::uuid
    when 'rides' then (v_row ->> 'driver_id')::uuid
    when 'profiles' then (v_row ->> 'id')::uuid
    when 'proposal_parties' then (v_row ->> 'profile_id')::uuid
    when 'department_members' then (v_row ->> 'profile_id')::uuid
    when 'sadran_assignments' then (v_row ->> 'profile_id')::uuid
    else null
  end;

  if tg_table_name='ride_change_parties' then
    select department_id,week_start into v_dept,v_week from public.ride_change_requests where id=(v_row->>'change_id')::uuid;
  end if;

  if v_subject is null and v_row ? 'request_id' then
    select requester_id into v_subject from public.requests where id = (v_row ->> 'request_id')::uuid;
  end if;

  if public.is_admin() then
    v_actor_role := 'admin';
  elsif v_dept is not null then
    select dm.role into v_actor_role from public.department_members dm
    where dm.department_id = v_dept and dm.profile_id = (select auth.uid()) and dm.removed_at is null limit 1;
  end if;

  insert into public.audit_log (actor_id, actor_role, table_name, row_id, action, department_id, week_start,
    subject_profile_id, before, after, changed_columns, reason, txid)
  values (
    (select auth.uid()), v_actor_role, tg_table_name, v_row_id, lower(tg_op)::public.audit_action,
    v_dept, v_week, v_subject, v_before, v_after, v_changed,
    coalesce(nullif(current_setting('app.audit_reason', true), ''), v_row ->> 'status_reason'),
    public._audit_txid()
  );

  return coalesce(new, old);
end;
$$;

-- The board's tables an undo may touch, and how a row is found from its audited jsonb (`$1`).
create or replace function public._undo_row_where(p_table text) returns text
  language sql immutable set search_path = public, pg_temp as $$
  select case p_table
    when 'ride_requests' then 'ride_id = ($1->>''ride_id'')::uuid and request_id = ($1->>''request_id'')::uuid and leg = ($1->>''leg'')::public.ride_leg'
    when 'weeks' then 'department_id = ($1->>''department_id'')::uuid and week_start = ($1->>''week_start'')::date'
    else 'id = ($1->>''id'')::uuid' end;
$$;

create or replace function public._undo_tables() returns text[]
  language sql immutable set search_path = public, pg_temp as $$
  select array['rides', 'ride_requests', 'requests', 'ride_passengers', 'proposals', 'proposal_parties',
               'waitlist_groups', 'waitlist_group_members', 'freed_slot_offers', 'freed_slot_claims', 'weeks'];
$$;

-- The department a row of an undoable table belongs to (child rows through their parent).
create or replace function public._undo_row_department(p_table text, p_row jsonb) returns uuid
  language sql stable security definer set search_path = public, pg_temp as $$
  select coalesce(
    nullif(p_row ->> 'department_id', '')::uuid,
    case p_table
      when 'ride_requests' then (select r.department_id from public.rides r where r.id = (p_row ->> 'ride_id')::uuid)
      when 'proposal_parties' then (select p.department_id from public.proposals p where p.id = (p_row ->> 'proposal_id')::uuid)
      when 'freed_slot_claims' then (select o.department_id from public.freed_slot_offers o where o.id = (p_row ->> 'offer_id')::uuid)
    end);
$$;

-- `marker` = the caller's latest audit row on that week; `txids` = the caller's transactions on that week after
-- `p_after` (oldest first; empty when `p_after` is null). The board takes a marker before an action and collects the
-- action's transactions after it (one action may be several calls: a proposal created and agreed).
create or replace function public.board_changes_since(p_department_id uuid, p_week_start date, p_after bigint default null)
  returns jsonb
  language plpgsql stable security definer set search_path = public, pg_temp as $$
begin
  if not public.can_manage_week(p_department_id, p_week_start) then
    raise exception 'not_authorized' using errcode = 'P0001';
  end if;
  return jsonb_build_object(
    'marker', coalesce((select max(a.id) from public.audit_log a
                         where a.actor_id = (select auth.uid()) and a.txid is not null
                           and a.department_id = p_department_id and a.week_start = p_week_start), 0),
    'txids', coalesce((select jsonb_agg(x.txid order by x.first_id) from (
                         select a.txid, min(a.id) as first_id from public.audit_log a
                          where p_after is not null and a.id > p_after
                            and a.actor_id = (select auth.uid()) and a.txid is not null
                            and a.department_id = p_department_id and a.week_start = p_week_start
                          group by a.txid) x), '[]'::jsonb));
end $$;

-- One transaction reversed (the checks below, then its audit rows newest first). Internal: `undo_board_change`
-- authorizes and calls it for each of an action's transactions, newest first, in one transaction.
create or replace function public._undo_board_txid(p_department_id uuid, p_txid bigint) returns void
  language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_actor uuid := (select auth.uid());
  v_prev_sys text := coalesce(current_setting('app.system_status_transition', true), 'off');
  v_at timestamptz; v_bad text; v_row record; v_cur jsonb; v_where text; v_cols text;
begin
  select min(a.at) into v_at from public.audit_log a where a.txid = p_txid;
  if v_at is null then raise exception 'undo_not_found' using errcode = 'P0001'; end if;
  -- only the caller's own change, on this department and week
  if exists (select 1 from public.audit_log a where a.txid = p_txid and a.actor_id is distinct from v_actor) then
    raise exception 'not_authorized' using errcode = 'P0001';
  end if;
  select a.table_name into v_bad from public.audit_log a
   where a.txid = p_txid and a.table_name <> all(public._undo_tables()) limit 1;
  if v_bad is not null then
    raise exception 'undo_not_possible' using errcode = 'P0001', detail = v_bad;
  end if;
  if exists (select 1 from public.audit_log a where a.txid = p_txid
             and public._undo_row_department(a.table_name, coalesce(a.after, a.before)) is distinct from p_department_id) then
    raise exception 'not_authorized' using errcode = 'P0001';
  end if;
  -- sending is final (owner 2026-11-08): a change that already told someone (a notice written at once, not held
  -- by the board) about one of its rides, requests or proposals is not undone
  if exists (select 1 from public.notifications n
              where n.created_at = v_at and n.department_id = p_department_id
                and exists (select 1 from public.audit_log a where a.txid = p_txid and a.table_name in ('rides', 'requests', 'proposals')
                              and a.row_id in (n.data ->> 'ride_id', n.data ->> 'request_id', n.data ->> 'proposal_id'))) then
    raise exception 'undo_already_notified' using errcode = 'P0001';
  end if;
  -- every row must still be as the change left it
  for v_row in
    select distinct on (a.table_name, a.row_id) a.table_name, a.after, a.before
      from public.audit_log a where a.txid = p_txid order by a.table_name, a.row_id, a.id desc
  loop
    v_where := public._undo_row_where(v_row.table_name);
    execute format('select to_jsonb(t) from public.%I t where %s', v_row.table_name, v_where)
      into v_cur using coalesce(v_row.after, v_row.before);
    if v_row.after is null then
      if v_cur is not null then raise exception 'undo_stale' using errcode = 'P0001'; end if;
    elsif v_cur is null or (v_cur - 'updated_at' - 'phone') is distinct from (v_row.after - 'updated_at') then
      raise exception 'undo_stale' using errcode = 'P0001';
    end if;
  end loop;

  perform set_config('app.audit_reason', 'undo_board_change', true);
  perform set_config('app.system_status_transition', 'on', true);
  -- Rows come back one at a time, so two rides that traded cars (a swap, a drag) pass through a moment where both
  -- sit on one car: like `swap_day_cars`, the neighbour checks wait for the final state, checked right after.
  set constraints public.rides_no_overlap_per_car deferred;
  perform set_config('app.day_car_swap', 'on', true);
  for v_row in select a.* from public.audit_log a where a.txid = p_txid order by a.id desc loop
    v_where := public._undo_row_where(v_row.table_name);
    if v_row.action = 'insert' then
      execute format('delete from public.%I where %s', v_row.table_name, v_where) using v_row.after;
    else
      select string_agg(quote_ident(att.attname), ', ' order by att.attnum) into v_cols
        from pg_attribute att
       where att.attrelid = format('public.%I', v_row.table_name)::regclass
         and att.attnum > 0 and not att.attisdropped and att.attgenerated = '' and att.attidentity = ''
         and v_row.before ? att.attname;
      if v_row.action = 'delete' then
        execute format('insert into public.%I (%s) select %s from jsonb_populate_record(null::public.%I, $1)',
          v_row.table_name, v_cols, v_cols, v_row.table_name) using v_row.before;
      else
        execute format('update public.%I set (%s) = (select %s from jsonb_populate_record(null::public.%I, $1)) where %s',
          v_row.table_name, v_cols, v_cols, v_row.table_name, v_where) using v_row.before;
      end if;
    end if;
  end loop;
  perform set_config('app.day_car_swap', 'off', true);
  perform set_config('app.system_status_transition', v_prev_sys, true);
  -- the restored rides against everything else on their cars now (a car given to someone else meanwhile)
  if exists (
    select 1 from public.rides r1
    join public.rides r2 on r2.car_id = r1.car_id and r2.id <> r1.id
    where r1.id in (select a.row_id::uuid from public.audit_log a where a.txid = p_txid and a.table_name = 'rides')
      and r1.status <> 'cancelled' and not r1.draft_hold and r2.status <> 'cancelled' and not r2.draft_hold
      and not r1.planning_conflict and not r2.planning_conflict
      and not (r1.series_id is not null and r1.series_id = r2.series_id)
      and tstzrange(r1.starts_at, r1.blocked_until, '[)') && tstzrange(r2.starts_at, r2.blocked_until, '[)')
  ) then
    raise exception 'ride_time_overlap' using errcode = 'P0001';
  end if;
  set constraints public.rides_no_overlap_per_car immediate;
end $$;

-- An action's transactions (oldest first, from `board_changes_since`), reversed newest first in one transaction.
-- Returns the undo's own transaction: undoing that is the redo.
create or replace function public.undo_board_change(p_department_id uuid, p_week_start date, p_txids bigint[]) returns bigint
  language plpgsql security definer set search_path = public, pg_temp as $$
declare i int;
begin
  if not public.can_manage_week(p_department_id, p_week_start) then
    raise exception 'not_authorized' using errcode = 'P0001';
  end if;
  if exists (select 1 from public.weeks where department_id = p_department_id and week_start = p_week_start and phase = 'archived') then
    raise exception 'week_archived' using errcode = 'P0001';
  end if;
  if coalesce(cardinality(p_txids), 0) = 0 then raise exception 'undo_not_found' using errcode = 'P0001'; end if;
  for i in reverse cardinality(p_txids)..1 loop
    perform public._undo_board_txid(p_department_id, p_txids[i]);
  end loop;
  return public._audit_txid();
end $$;

revoke all on function public._undo_row_where(text) from public, anon;
revoke all on function public._undo_tables() from public, anon;
revoke all on function public._undo_row_department(text, jsonb) from public, anon;
revoke all on function public.board_changes_since(uuid, date, bigint) from public, anon;
revoke all on function public._undo_board_txid(uuid, bigint) from public, anon;
revoke all on function public.undo_board_change(uuid, date, bigint[]) from public, anon;
grant execute on function public.board_changes_since(uuid, date, bigint) to authenticated;
grant execute on function public.undo_board_change(uuid, date, bigint[]) to authenticated;
