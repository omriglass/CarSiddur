-- SW1 (docs/TODO.md, owner go 2026-11-26): production hangs are the database swapping, and the biggest per-call cost
-- is rebuilding every ride from scratch on every read (`_board_rows_build`: served requests, people, stops + ETAs,
-- route, relay partner, series). Every ride read — my rides, siddur, board, `rides_with_people`, `week_parts` —
-- goes through `board_rows()`. This migration stores each ride's built row once and keeps it fresh:
--
--   * `ride_rows`        one row per non-cancelled ride: the `v_board_rides` row as jsonb, built as the service
--                        caller (so `people[].leg`, stops and route are always filled — `board_rows` only ever
--                        returns rides of the viewer's own departments, where the viewer's build equals this one).
--   * `ride_rows_dirty`  ride ids changed by the current transaction (keyed by txid, so concurrent writers never
--                        conflict). Row triggers on every table the builder reads insert into it.
--   * one deferred constraint trigger rebuilds this transaction's dirty rides once, at commit.
--   * `board_rows()` reads the stored row; a ride with no row yet, or dirty in this very transaction (an RPC that
--     writes and then reads), is built on the spot as before.
--
-- Guard: `supabase/tests/_board_rows_oracle.sql` (run at the end of every SQL suite) flushes and asserts the stored
-- row equals a fresh build for every ride. A migration that changes what the builder returns (a new
-- `v_board_rides` column, a route/ETA rule) ends with `select public.ride_rows_rebuild_all();`.

create table public.ride_rows (
  ride_id uuid primary key references public.rides(id) on delete cascade,
  department_id uuid not null,
  week_start date not null,
  "row" jsonb not null,
  built_at timestamptz not null default now()
);
create index ride_rows_department_week on public.ride_rows (department_id, week_start);
alter table public.ride_rows enable row level security;
alter table public.ride_rows force row level security;
revoke all on table public.ride_rows from public, anon, authenticated;
comment on table public.ride_rows is
  'SW1: stored v_board_rides row per non-cancelled ride (built as service), rebuilt at commit from ride_rows_dirty. Read only through board_rows(). No browser access.';

create table public.ride_rows_dirty (
  txid bigint not null,
  ride_id uuid not null,
  primary key (txid, ride_id)
);
alter table public.ride_rows_dirty enable row level security;
alter table public.ride_rows_dirty force row level security;
revoke all on table public.ride_rows_dirty from public, anon, authenticated;
comment on table public.ride_rows_dirty is
  'SW1: rides changed by the current transaction (txid). Emptied by _ride_rows_flush() at commit; never holds rows between transactions.';

-- ---------------------------------------------------------------------------------------------------------------
-- Marking
-- ---------------------------------------------------------------------------------------------------------------

-- The given rides, plus every relay ride on the same car and week (a relay ride shows its neighbouring ride's
-- driver / first requester / time as `relay_partner`).
create or replace function public._ride_rows_mark(p_ids uuid[])
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if p_ids is null or cardinality(p_ids) = 0 then return; end if;
  insert into public.ride_rows_dirty (txid, ride_id)
  select txid_current(), x.id
    from (select unnest(p_ids) as id
          union
          select n.id
            from public.rides r
            join public.rides n on n.car_id = r.car_id and n.week_start = r.week_start
                               and n.department_id = r.department_id and n.id <> r.id
           where r.id = any(p_ids)
             and exists (select 1 from public.ride_requests e
                          where e.ride_id = n.id and e.role = 'driver' and e.car_mode = 'relay')) x
   where x.id is not null
  on conflict do nothing;
end $$;

-- Relay rides on one car and week (a ride left that car-week, or was deleted).
create or replace function public._ride_rows_mark_car_week(p_department_id uuid, p_car_id uuid, p_week_start date)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if p_car_id is null then return; end if;
  insert into public.ride_rows_dirty (txid, ride_id)
  select txid_current(), n.id
    from public.rides n
   where n.car_id = p_car_id and n.week_start = p_week_start and n.department_id = p_department_id
     and exists (select 1 from public.ride_requests e
                  where e.ride_id = n.id and e.role = 'driver' and e.car_mode = 'relay')
  on conflict do nothing;
end $$;

-- Every ride a set of requests is on.
create or replace function public._ride_rows_mark_requests(p_request_ids uuid[])
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if p_request_ids is null or cardinality(p_request_ids) = 0 then return; end if;
  perform public._ride_rows_mark(array(select distinct rr.ride_id from public.ride_requests rr
                                         where rr.request_id = any(p_request_ids)));
end $$;

-- Every non-cancelled ride of a department (a place, a stored route or a route setting changed: names, ETAs and
-- routes of any ride may move). Rare admin edits; a few hundred rides.
create or replace function public._ride_rows_mark_department(p_department_id uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if p_department_id is null then return; end if;
  insert into public.ride_rows_dirty (txid, ride_id)
  select txid_current(), r.id from public.rides r
   where r.department_id = p_department_id and r.status <> 'cancelled'
  on conflict do nothing;
end $$;

-- One trigger function for every source table.
create or replace function public._ride_rows_mark_trg()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  case tg_table_name
  when 'rides' then
    if tg_op in ('UPDATE', 'DELETE') then
      perform public._ride_rows_mark(array[old.id]);
      perform public._ride_rows_mark_car_week(old.department_id, old.car_id, old.week_start);
    end if;
    if tg_op in ('INSERT', 'UPDATE') then
      perform public._ride_rows_mark(array[new.id]);
      if tg_op = 'INSERT' or (old.car_id, old.week_start) is distinct from (new.car_id, new.week_start) then
        perform public._ride_rows_mark_car_week(new.department_id, new.car_id, new.week_start);
      end if;
    end if;
  when 'ride_requests' then
    -- the ride itself, and every other ride of the request (a request's leg / route on one ride reads its others)
    if tg_op in ('UPDATE', 'DELETE') then
      perform public._ride_rows_mark(array[old.ride_id]);
      perform public._ride_rows_mark_requests(array[old.request_id]);
    end if;
    if tg_op in ('INSERT', 'UPDATE') then
      perform public._ride_rows_mark(array[new.ride_id]);
      perform public._ride_rows_mark_requests(array[new.request_id]);
    end if;
  when 'requests' then
    if tg_op = 'UPDATE' and old is not distinct from new then return null; end if;
    perform public._ride_rows_mark_requests(array[coalesce(new.id, old.id)]);
  when 'request_stops', 'request_companions', 'request_children' then
    perform public._ride_rows_mark_requests(array_remove(array[
      case when tg_op <> 'INSERT' then old.request_id end,
      case when tg_op <> 'DELETE' then new.request_id end], null));
  when 'ride_passengers' then
    perform public._ride_rows_mark(array_remove(array[
      case when tg_op <> 'INSERT' then old.ride_id end,
      case when tg_op <> 'DELETE' then new.ride_id end], null));
  when 'children' then
    if tg_op = 'UPDATE' and old.full_name is not distinct from new.full_name then return null; end if;
    perform public._ride_rows_mark_requests(array(select rc.request_id from public.request_children rc
                                                    where rc.child_id = coalesce(new.id, old.id)));
  when 'profiles' then
    if old.full_name is not distinct from new.full_name then return null; end if;
    perform public._ride_rows_mark(array(
      select r.id from public.rides r where r.driver_id = new.id
      union
      select rr.ride_id from public.requests q join public.ride_requests rr on rr.request_id = q.id
       where q.requester_id = new.id
      union
      select rr.ride_id from public.request_companions rc join public.ride_requests rr on rr.request_id = rc.request_id
       where rc.profile_id = new.id));
  when 'ride_types' then
    if old.code is not distinct from new.code then return null; end if;
    perform public._ride_rows_mark_requests(array(select q.id from public.requests q where q.ride_type_id = new.id));
  when 'destinations', 'place_distances' then
    if tg_op <> 'INSERT' then perform public._ride_rows_mark_department(old.department_id); end if;
    if tg_op <> 'DELETE' and (tg_op = 'INSERT' or new.department_id is distinct from old.department_id) then
      perform public._ride_rows_mark_department(new.department_id);
    end if;
  when 'departments' then
    if old.home_destination_id is not distinct from new.home_destination_id then return null; end if;
    perform public._ride_rows_mark_department(new.id);
  when 'department_settings' then
    if tg_op = 'UPDATE'
       and (old.stop_minutes, old.travel_margin_percent,
            old.rush_morning_start, old.rush_morning_end, old.rush_morning_percent,
            old.rush_afternoon_start, old.rush_afternoon_end, old.rush_afternoon_percent)
           is not distinct from
           (new.stop_minutes, new.travel_margin_percent,
            new.rush_morning_start, new.rush_morning_end, new.rush_morning_percent,
            new.rush_afternoon_start, new.rush_afternoon_end, new.rush_afternoon_percent) then
      return null;
    end if;
    perform public._ride_rows_mark_department(coalesce(new.department_id, old.department_id));
  end case;
  return null;
end $$;

create trigger ride_rows_mark after insert or update or delete on public.rides
  for each row execute function public._ride_rows_mark_trg();
create trigger ride_rows_mark after insert or update or delete on public.ride_requests
  for each row execute function public._ride_rows_mark_trg();
create trigger ride_rows_mark after insert or update or delete on public.requests
  for each row execute function public._ride_rows_mark_trg();
create trigger ride_rows_mark after insert or update or delete on public.request_stops
  for each row execute function public._ride_rows_mark_trg();
create trigger ride_rows_mark after insert or update or delete on public.request_companions
  for each row execute function public._ride_rows_mark_trg();
create trigger ride_rows_mark after insert or update or delete on public.request_children
  for each row execute function public._ride_rows_mark_trg();
create trigger ride_rows_mark after insert or update or delete on public.ride_passengers
  for each row execute function public._ride_rows_mark_trg();
create trigger ride_rows_mark after update or delete on public.children
  for each row execute function public._ride_rows_mark_trg();
create trigger ride_rows_mark after update of full_name on public.profiles
  for each row execute function public._ride_rows_mark_trg();
create trigger ride_rows_mark after update of code on public.ride_types
  for each row execute function public._ride_rows_mark_trg();
create trigger ride_rows_mark after insert or update or delete on public.destinations
  for each row execute function public._ride_rows_mark_trg();
create trigger ride_rows_mark after insert or update or delete on public.place_distances
  for each row execute function public._ride_rows_mark_trg();
create trigger ride_rows_mark after update of home_destination_id on public.departments
  for each row execute function public._ride_rows_mark_trg();
create trigger ride_rows_mark after insert or update on public.department_settings
  for each row execute function public._ride_rows_mark_trg();

-- ---------------------------------------------------------------------------------------------------------------
-- Rebuild
-- ---------------------------------------------------------------------------------------------------------------

-- Rebuild the given rides (built as the service caller) into ride_rows; cancelled / deleted rides lose their row.
create or replace function public._ride_rows_build_into(p_ids uuid[])
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_claims text := current_setting('request.jwt.claims', true);
  v_sub text := current_setting('request.jwt.claim.sub', true);
begin
  if p_ids is null or cardinality(p_ids) = 0 then return; end if;
  -- Built as the service caller: the builder's helpers then skip their per-viewer visibility, so the stored row is
  -- the full one. board_rows() decides who may see which ride, exactly as before.
  perform set_config('request.jwt.claims', '', true);
  perform set_config('request.jwt.claim.sub', '', true);

  insert into public.ride_rows as rr (ride_id, department_id, week_start, "row", built_at)
  select b.id, b.department_id, b.week_start, to_jsonb(b), now()
    from public._board_rows_build(p_ids, (select array_agg(distinct r.department_id) from public.rides r
                                           where r.id = any(p_ids))) b
  on conflict (ride_id) do update
     set department_id = excluded.department_id, week_start = excluded.week_start,
         "row" = excluded."row", built_at = excluded.built_at
   where rr."row" is distinct from excluded."row"
      or rr.department_id is distinct from excluded.department_id
      or rr.week_start is distinct from excluded.week_start;

  delete from public.ride_rows rr
   where rr.ride_id = any(p_ids)
     and not exists (select 1 from public.rides r where r.id = rr.ride_id and r.status <> 'cancelled');

  perform set_config('request.jwt.claims', coalesce(v_claims, ''), true);
  perform set_config('request.jwt.claim.sub', coalesce(v_sub, ''), true);
end $$;

-- This transaction's dirty rides, rebuilt once. Called at commit by the deferred trigger below, and by the SQL
-- oracle (suites roll back, so their writes never reach the commit-time flush).
create or replace function public._ride_rows_flush()
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_tx bigint := txid_current_if_assigned();
  v_ids uuid[];
begin
  if v_tx is null then return; end if;
  with d as (delete from public.ride_rows_dirty where txid = v_tx returning ride_id)
  select array_agg(distinct d.ride_id) into v_ids from d;
  if v_ids is null then return; end if;
  -- Two transactions rebuilding the same ride: the second waits for the first to commit, then builds from what the
  -- first committed (each statement below takes a fresh snapshot), so the last writer never stores an older row.
  perform pg_advisory_xact_lock(73010, k.h)
     from (select distinct hashtext(x::text) as h from unnest(v_ids) x order by 1) k;
  perform public._ride_rows_build_into(v_ids);
end $$;

create or replace function public._ride_rows_flush_trg()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  perform public._ride_rows_flush();
  return null;
end $$;

create constraint trigger ride_rows_flush after insert on public.ride_rows_dirty
  deferrable initially deferred for each row execute function public._ride_rows_flush_trg();

-- Every ride, rebuilt. For a migration that changes what the builder returns, and for the debug / replay copies
-- (loaded with triggers off).
create or replace function public.ride_rows_rebuild_all()
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare v_ids uuid[];
begin
  delete from public.ride_rows rr
   where not exists (select 1 from public.rides r where r.id = rr.ride_id and r.status <> 'cancelled');
  select array_agg(r.id) into v_ids from public.rides r where r.status <> 'cancelled';
  perform public._ride_rows_build_into(v_ids);
  return coalesce(cardinality(v_ids), 0);
end $$;

revoke all on function public._ride_rows_mark(uuid[]) from public, anon, authenticated;
revoke all on function public._ride_rows_mark_car_week(uuid, uuid, date) from public, anon, authenticated;
revoke all on function public._ride_rows_mark_requests(uuid[]) from public, anon, authenticated;
revoke all on function public._ride_rows_mark_department(uuid) from public, anon, authenticated;
revoke all on function public._ride_rows_mark_trg() from public, anon, authenticated;
revoke all on function public._ride_rows_build_into(uuid[]) from public, anon, authenticated;
revoke all on function public._ride_rows_flush() from public, anon, authenticated;
revoke all on function public._ride_rows_flush_trg() from public, anon, authenticated;
revoke all on function public.ride_rows_rebuild_all() from public, anon, authenticated;

-- ---------------------------------------------------------------------------------------------------------------
-- Read
-- ---------------------------------------------------------------------------------------------------------------

create or replace function public.board_rows(p_ride_ids uuid[])
returns setof public.v_board_rides
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_ids uuid[]; v_leg_depts uuid[]; v_build uuid[];
  v_service boolean := (select auth.uid()) is null;
  v_tx bigint := txid_current_if_assigned();
begin
  if p_ride_ids is null or cardinality(p_ride_ids) = 0 then return; end if;

  select array_agg(d.department_id) into v_leg_depts
    from (select distinct r.department_id from public.rides r where r.id = any(p_ride_ids)) d
   where v_service or public.member_of(d.department_id) or public.is_admin();
  if v_leg_depts is null then return; end if;

  -- visibility: rides_select's rule, the helpers evaluated once per week / per day
  select array_agg(r.id) into v_ids
    from public.rides r
    join (select w.department_id, w.week_start, (v_service or public.can_manage_week(w.department_id, w.week_start)) as manages
            from (select distinct r2.department_id, r2.week_start from public.rides r2
                   where r2.id = any(p_ride_ids) and r2.department_id = any(v_leg_depts)) w) wk
      on wk.department_id = r.department_id and wk.week_start = r.week_start
   where r.id = any(p_ride_ids) and r.status <> 'cancelled'
     and (wk.manages
          or (r.status <> 'draft' and public.is_approved()
              and public.is_day_public(r.department_id, r.week_start, (r.starts_at at time zone 'Asia/Jerusalem')::date)));
  if v_ids is null then return; end if;

  -- SW1: the stored row, unless the ride has none yet or this transaction changed it (not rebuilt before commit)
  select array_agg(x.id) into v_build
    from unnest(v_ids) x(id)
   where not exists (select 1 from public.ride_rows s where s.ride_id = x.id)
      or (v_tx is not null and exists (select 1 from public.ride_rows_dirty dd where dd.txid = v_tx and dd.ride_id = x.id));

  -- lateral, not `(jsonb_populate_record(…)).*` — that form calls the function once per column
  return query
  select p.*
    from public.ride_rows s
    cross join lateral jsonb_populate_record(null::public.v_board_rides, s."row") p
   where s.ride_id = any(v_ids) and (v_build is null or not (s.ride_id = any(v_build)));
  if v_build is not null then
    return query select * from public._board_rows_build(v_build, v_leg_depts);
  end if;
end $$;

-- Backfill.
select public.ride_rows_rebuild_all();
