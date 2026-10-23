-- REQ item 149 (D1): change counters so open screens learn about other people's changes with one
-- cheap read instead of re-fetching or polling every list.
--
--   week_change_seq(department_id, week_start, seq, public_seq)
--     seq        : moves on ANY change of the week (Sadran screens watch it)
--     public_seq : moves only when something members can see changed — a published/live day's
--                  rows, a sent (non-draft) proposal, publishing, flushing held board notices, a
--                  week phase/days/close-time change (member screens watch it)
--   department_change_seq(department_id, seq)
--     moves on catalog changes (cars, maintenance blocks, settings, members, policies)
--
-- Deliberately NOT columns on `weeks`: weeks has bump_version()/audit_row() triggers (a bump would
-- change expected_version under the Sadran and write audit rows) and its row would be locked by
-- every writer of the week for the rest of the transaction.
--
-- Mechanism, cheap and lock-friendly:
--   1. AFTER ... FOR EACH STATEMENT triggers with transition tables on every table that matters
--      call `_wcs_capture()`, which derives the affected (department, week, member-visible?) keys
--      of the statement's rows (one set-based query) and notes them in a transaction-local setting
--      (`app.wcs_state`). No counter row is touched, so writers of the same week never wait on
--      each other during the transaction.
--   2. The first note of a transaction inserts one row into `week_change_pending`, whose DEFERRABLE
--      INITIALLY DEFERRED constraint trigger runs `_wcs_flush()` once at commit: it bumps each noted
--      counter exactly once (keys in a fixed order, so two committers cannot deadlock), then clears
--      the state. A solve or publish touching 90 rows therefore bumps each counter once.
--   A rolled-back (sub)transaction rolls back its notes with its rows (set_config local + the
--   pending insert are both transactional). The flush never raises: a counter failure must never
--   fail the user's write (it is logged as a WARNING instead).
-- D2 (20261028140000) adds the Realtime broadcast to `_wcs_flush()`.

create table public.week_change_seq (
  department_id uuid not null references public.departments(id) on delete cascade,
  week_start date not null,
  seq bigint not null default 0,
  public_seq bigint not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (department_id, week_start)
);
comment on table public.week_change_seq is
  'REQ 149: per (department, week) change counters. seq = any change (Sadran screens); public_seq = member-visible changes. Written only by _wcs_flush() at commit; not audited.';

create table public.department_change_seq (
  department_id uuid primary key references public.departments(id) on delete cascade,
  seq bigint not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
comment on table public.department_change_seq is
  'REQ 149: per-department catalog change counter (cars, maintenance, settings, members, policies). Written only by _wcs_flush().';

create table public.week_change_pending (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now()
);
comment on table public.week_change_pending is
  'REQ 149: one transient row per writing transaction; its deferred constraint trigger runs _wcs_flush() at commit and deletes it.';

alter table public.week_change_seq enable row level security;
alter table public.week_change_seq force row level security;
alter table public.department_change_seq enable row level security;
alter table public.department_change_seq force row level security;
alter table public.week_change_pending enable row level security;
alter table public.week_change_pending force row level security;

-- Same reach as weeks_select: department members, admins, and any approved member for a published
-- week (they may read its rides — read-only department switching). Counters carry no row data.
create policy "week_change_seq_select" on public.week_change_seq for select to authenticated
  using (public.member_of(department_id) or public.is_admin()
         or (public.is_approved() and public.is_week_public(department_id, week_start)));
create policy "department_change_seq_select" on public.department_change_seq for select to authenticated
  using (public.member_of(department_id) or public.is_admin());
-- week_change_pending: no policies (definer functions only).

revoke all on public.week_change_seq from anon, authenticated;
revoke all on public.department_change_seq from anon, authenticated;
revoke all on public.week_change_pending from anon, authenticated;
grant select on public.week_change_seq to authenticated;
grant select on public.department_change_seq to authenticated;

-- ---------------------------------------------------------------------------
-- Note one key in the transaction-local state; register the commit-time flush once.
--   p_kind 'w' (week: p_week required) or 'd' (department catalog).
-- State: {"w|<dept>|<week>": 0|1, "d|<dept>|": 0} — 1 = member-visible (public_seq too).
-- ---------------------------------------------------------------------------
create or replace function public._wcs_note(p_kind text, p_department_id uuid, p_week_start date, p_public boolean)
returns void
language plpgsql security definer
set search_path = public, pg_temp
as $$
declare
  v_state jsonb := coalesce(nullif(current_setting('app.wcs_state', true), ''), '{}')::jsonb;
  v_key text := p_kind || '|' || p_department_id::text || '|' || coalesce(p_week_start::text, '');
  v_prev text := v_state ->> v_key;
begin
  if p_department_id is null or (p_kind = 'w' and p_week_start is null) then return; end if;
  if v_prev = '1' or (v_prev = '0' and not coalesce(p_public, false)) then return; end if;
  v_state := v_state || jsonb_build_object(v_key, case when coalesce(p_public, false) then 1 else 0 end);
  perform set_config('app.wcs_state', v_state::text, true);
  if coalesce(current_setting('app.wcs_registered', true), '') <> 'on' then
    insert into public.week_change_pending default values;
    perform set_config('app.wcs_registered', 'on', true);
  end if;
end;
$$;

-- ---------------------------------------------------------------------------
-- Statement-level capture. Each table's template selects (d uuid, w date, day date, m int) from
-- the transition table %1$I (new_rows / old_rows):
--   m = 0: Sadran-only change (seq);  1: member-visible when `day` is a public day;  2: always
--   member-visible. A department catalog table's template selects (d uuid) only.
-- $1 = TG_OP inside the template.
-- ---------------------------------------------------------------------------
create or replace function public._wcs_capture()
returns trigger
language plpgsql security definer
set search_path = public, pg_temp
as $$
declare
  v_tables text[] := case TG_OP when 'INSERT' then array['new_rows'] when 'DELETE' then array['old_rows']
                                else array['new_rows', 'old_rows'] end;
  v_tpl text;
  v_dept_tpl text;
  t text;
  k record;
begin
  case TG_TABLE_NAME
    when 'rides' then
      v_tpl := 'select department_id d, week_start w, (starts_at at time zone ''Asia/Jerusalem'')::date d2,
                       case when status <> ''draft'' then 1 else 0 end m from %1$I';
    when 'requests' then
      v_tpl := 'select r.department_id d, r.week_start w, v.day d2, 1 m from %1$I r
                  cross join lateral (values ((r.depart_at at time zone ''Asia/Jerusalem'')::date),
                                             ((r.return_at at time zone ''Asia/Jerusalem'')::date)) v(day)';
    when 'ride_requests' then
      v_tpl := 'select coalesce(ri.department_id, q.department_id) d, coalesce(ri.week_start, q.week_start) w,
                       (ri.starts_at at time zone ''Asia/Jerusalem'')::date d2,
                       case when ri.id is not null and ri.status <> ''draft'' then 1 else 0 end m
                  from %1$I x left join public.rides ri on ri.id = x.ride_id
                  left join public.requests q on q.id = x.request_id';
    when 'request_companions', 'request_children', 'request_stops', 'request_alternatives' then
      v_tpl := 'select q.department_id d, q.week_start w, v.day d2, 1 m
                  from %1$I x join public.requests q on q.id = x.request_id
                  cross join lateral (values ((q.depart_at at time zone ''Asia/Jerusalem'')::date),
                                             ((q.return_at at time zone ''Asia/Jerusalem'')::date)) v(day)';
    when 'ride_passengers' then
      v_tpl := 'select x.department_id d, x.week_start w, (ri.starts_at at time zone ''Asia/Jerusalem'')::date d2,
                       case when ri.id is not null and ri.status <> ''draft'' then 1 else 0 end m
                  from %1$I x left join public.rides ri on ri.id = x.ride_id';
    when 'proposals' then
      v_tpl := 'select department_id d, week_start w, null::date d2, case when status <> ''draft'' then 2 else 0 end m from %1$I';
    when 'proposal_parties' then
      v_tpl := 'select p.department_id d, p.week_start w, null::date d2, case when p.status <> ''draft'' then 2 else 0 end m
                  from %1$I x join public.proposals p on p.id = x.proposal_id';
    when 'ride_change_requests', 'freed_slot_offers' then
      v_tpl := 'select department_id d, week_start w, (starts_at at time zone ''Asia/Jerusalem'')::date d2, 1 m from %1$I';
    when 'freed_slot_claims' then
      v_tpl := 'select o.department_id d, o.week_start w, (o.starts_at at time zone ''Asia/Jerusalem'')::date d2, 1 m
                  from %1$I x join public.freed_slot_offers o on o.id = x.offer_id';
    when 'waitlist_groups' then
      v_tpl := 'select department_id d, week_start w, day d2, 1 m from %1$I';
    when 'held_notices' then
      -- Holding a notice is Sadran-only; deleting (flush_held_notices, or a dropped notice) tells members.
      v_tpl := 'select department_id d, week_start w, null::date d2, case when $1 = ''DELETE'' then 2 else 0 end m from %1$I';
    when 'siddur_versions' then
      v_tpl := 'select department_id d, week_start w, null::date d2, 2 m from %1$I';
    when 'weeks' then
      if TG_OP = 'UPDATE' then
        -- Member-visible only when what members see of the week changed (phase, published days,
        -- request window, published version); version/reminder bookkeeping is Sadran-only.
        for k in
          select n.department_id d, n.week_start w,
                 bool_or((n.phase, n.published_days, n.open_at, n.close_at, n.publish_at, n.published_version_id)
                         is distinct from (o.phase, o.published_days, o.open_at, o.close_at, o.publish_at, o.published_version_id)) pub
            from new_rows n join old_rows o on o.department_id = n.department_id and o.week_start = n.week_start
           group by 1, 2
        loop
          perform public._wcs_note('w', k.d, k.w, k.pub);
        end loop;
        return null;
      end if;
      v_tpl := 'select department_id d, week_start w, null::date d2, 2 m from %1$I';
    when 'cars', 'car_maintenance_blocks', 'department_settings', 'department_members', 'policies' then
      v_dept_tpl := 'select distinct department_id d from %1$I';
    when 'policy_versions' then
      v_dept_tpl := 'select distinct p.department_id d from %1$I x join public.policies p on p.id = x.policy_id';
    else
      raise warning '_wcs_capture: no template for table %', TG_TABLE_NAME;
      return null;
  end case;

  foreach t in array v_tables loop
    if v_dept_tpl is not null then
      for k in execute format(v_dept_tpl, t) loop
        perform public._wcs_note('d', k.d, null, false);
      end loop;
    else
      for k in execute format(
        'select x.d, x.w, bool_or(case x.m when 2 then true
                                           when 1 then x.d2 is not null and public.is_day_public(x.d, x.w, x.d2)
                                           else false end) pub
           from (select distinct d, w, d2, m from (' || v_tpl || ') s where d is not null and w is not null) x
          group by x.d, x.w
          order by x.d, x.w', t) using TG_OP
      loop
        perform public._wcs_note('w', k.d, k.w, k.pub);
      end loop;
    end if;
  end loop;
  return null;
end;
$$;

-- ---------------------------------------------------------------------------
-- Commit-time flush: bump every noted counter once, in key order, then clear the state so a write
-- made later in the same transaction (another deferred trigger) registers a fresh flush.
-- ---------------------------------------------------------------------------
create or replace function public._wcs_flush()
returns trigger
language plpgsql security definer
set search_path = public, pg_temp
as $$
declare
  v_state jsonb := coalesce(nullif(current_setting('app.wcs_state', true), ''), '{}')::jsonb;
  k record;
  v_dept uuid; v_week date; v_pub boolean;
begin
  perform set_config('app.wcs_state', '', true);
  perform set_config('app.wcs_registered', '', true);
  delete from public.week_change_pending where id = new.id;
  for k in select key, value from jsonb_each_text(v_state) order by key loop
    begin
      v_dept := split_part(k.key, '|', 2)::uuid;
      v_pub := k.value = '1';
      if split_part(k.key, '|', 1) = 'w' then
        v_week := split_part(k.key, '|', 3)::date;
        insert into public.week_change_seq as c (department_id, week_start, seq, public_seq)
        values (v_dept, v_week, 1, case when v_pub then 1 else 0 end)
        on conflict (department_id, week_start) do update
          set seq = c.seq + 1,
              public_seq = c.public_seq + case when v_pub then 1 else 0 end,
              updated_at = now();
      else
        insert into public.department_change_seq as c (department_id, seq)
        values (v_dept, 1)
        on conflict (department_id) do update set seq = c.seq + 1, updated_at = now();
      end if;
    exception when others then
      -- A counter must never fail the user's write; the screens' focus refetch still catches up.
      raise warning '_wcs_flush: % (%)', sqlerrm, k.key;
    end;
  end loop;
  return null;
end;
$$;

revoke all on function public._wcs_note(text, uuid, date, boolean) from public, anon, authenticated;
revoke all on function public._wcs_capture() from public, anon, authenticated;
revoke all on function public._wcs_flush() from public, anon, authenticated;

create constraint trigger week_change_pending_flush
  after insert on public.week_change_pending
  deferrable initially deferred
  for each row execute function public._wcs_flush();

-- Three statement triggers per table (a trigger with transition tables takes one event).
do $$
declare t text;
begin
  foreach t in array array[
    'rides', 'ride_requests', 'requests', 'request_companions', 'request_children', 'request_stops',
    'request_alternatives', 'ride_passengers', 'proposals', 'proposal_parties', 'ride_change_requests',
    'waitlist_groups', 'freed_slot_offers', 'freed_slot_claims', 'held_notices', 'weeks', 'siddur_versions',
    'cars', 'car_maintenance_blocks', 'department_settings', 'department_members', 'policies', 'policy_versions'
  ] loop
    execute format('create trigger wcs_ins after insert on public.%I referencing new table as new_rows
                    for each statement execute function public._wcs_capture()', t);
    execute format('create trigger wcs_upd after update on public.%I referencing old table as old_rows new table as new_rows
                    for each statement execute function public._wcs_capture()', t);
    execute format('create trigger wcs_del after delete on public.%I referencing old table as old_rows
                    for each statement execute function public._wcs_capture()', t);
  end loop;
end $$;

-- ---------------------------------------------------------------------------
-- The browser's version check: both week counters for each asked week + the department counter.
-- SECURITY INVOKER: RLS on the counter tables decides; an unauthorised caller reads zeros.
-- ---------------------------------------------------------------------------
create or replace function public.week_change_seqs(p_department_id uuid, p_weeks date[])
returns table (week_start date, seq bigint, public_seq bigint, dept_seq bigint)
language sql stable security invoker
set search_path = public, pg_temp
as $$
  select w.week_start, coalesce(c.seq, 0), coalesce(c.public_seq, 0),
         coalesce((select d.seq from public.department_change_seq d where d.department_id = p_department_id), 0)
    from unnest(p_weeks) as w(week_start)
    left join public.week_change_seq c on c.department_id = p_department_id and c.week_start = w.week_start;
$$;

revoke all on function public.week_change_seqs(uuid, date[]) from public, anon;
grant execute on function public.week_change_seqs(uuid, date[]) to authenticated;
