-- TODO UN1 follow-up (owner 2026-11-08, chain test in `board_undo.sql`): undoing two board actions on the same ride
-- one after the other failed with `undo_stale` — the first undo restores the ride's columns but `bump_version` moves
-- its version on, so the second undo's "unchanged since?" check saw a different row. The check ignores the version
-- counter; every other column must still match.

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
  -- every row must still be as the change left it (the version counter aside: an undo of a later action on the same
  -- row restores its columns but bumps the version, and must not make the earlier action stale)
  for v_row in
    select distinct on (a.table_name, a.row_id) a.table_name, a.after, a.before
      from public.audit_log a where a.txid = p_txid order by a.table_name, a.row_id, a.id desc
  loop
    v_where := public._undo_row_where(v_row.table_name);
    execute format('select to_jsonb(t) from public.%I t where %s', v_row.table_name, v_where)
      into v_cur using coalesce(v_row.after, v_row.before);
    if v_row.after is null then
      if v_cur is not null then raise exception 'undo_stale' using errcode = 'P0001'; end if;
    elsif v_cur is null or (v_cur - 'updated_at' - 'phone' - 'version') is distinct from (v_row.after - 'updated_at' - 'version') then
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
