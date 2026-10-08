-- REQ §13.112 (c): "I need the car for N hours somewhere between A and B" — a round trip whose car block has a
-- fixed length and may start anywhere in a window. Stored on the existing columns as the earliest block
-- (depart_at = A, return_at = A + N, early flex 0, both late flexes = B - (A + N)) plus this flag, which means
-- "shift as one block, never stretch or shrink": solver and SQL shift paths read it.
--
-- 1. requests.duration_locked / request_templates.duration_locked (default false: every existing row unchanged).
-- 2. The late-flex checks only knew the six form values (0, 15 min, 30 min, 1 h, 2 h, 1 day). A window's slack is any
--    quarter hour up to a day, so a LOCKED row may carry such a value (early flexes stay on the six values).
-- 3. requests_duration_lock_guard (BEFORE INSERT/UPDATE): a lock that no longer describes a window (not a
--    single-day round trip, early flex, unequal late flexes) is dropped and the flex snapped back to a form value;
--    a change of the block's LENGTH by anything but submit_request is a change beyond the request's terms
--    (an accepted proposal, a ride edit that rewrites the request) and drops the lock too; an equal shift
--    (a shift proposal) keeps the window's END where the member put it (late flex shrinks/grows by the shift).
--    submit_request sets app.duration_lock_explicit = 'on' and decides the flag itself.
-- 4. assert_duration_lock(): the validation submit_request runs for an explicit `duration_locked: true`.

alter table public.requests add column duration_locked boolean not null default false;
alter table public.request_templates add column duration_locked boolean not null default false;

alter table public.requests
  drop constraint requests_flex_depart_late_ck,
  drop constraint requests_flex_return_late_ck;
alter table public.requests
  add constraint requests_flex_depart_late_ck check (
    flex_depart_late in ('0', '15 min', '30 min', '1 hour', '2 hours', '1 day')
    or (duration_locked and flex_depart_late > interval '0' and flex_depart_late <= interval '1 day'
        and extract(epoch from flex_depart_late)::bigint % 900 = 0)),
  add constraint requests_flex_return_late_ck check (
    flex_return_late in ('0', '15 min', '30 min', '1 hour', '2 hours', '1 day')
    or (duration_locked and flex_return_late > interval '0' and flex_return_late <= interval '1 day'
        and extract(epoch from flex_return_late)::bigint % 900 = 0));

alter table public.request_templates
  drop constraint request_templates_flex_depart_late_ck,
  drop constraint request_templates_flex_return_late_ck;
alter table public.request_templates
  add constraint request_templates_flex_depart_late_ck check (
    flex_depart_late in ('0', '15 min', '30 min', '1 hour', '2 hours', '1 day')
    or (duration_locked and flex_depart_late > interval '0' and flex_depart_late <= interval '1 day'
        and extract(epoch from flex_depart_late)::bigint % 900 = 0)),
  add constraint request_templates_flex_return_late_ck check (
    flex_return_late in ('0', '15 min', '30 min', '1 hour', '2 hours', '1 day')
    or (duration_locked and flex_return_late > interval '0' and flex_return_late <= interval '1 day'
        and extract(epoch from flex_return_late)::bigint % 900 = 0));

-- The largest form flex value that is not more than `i` (what an unlocked row may store).
create or replace function public._flex_floor(i interval) returns interval
language sql immutable set search_path = public, pg_temp as $$
  select case
    when i >= interval '1 day' then interval '1 day'
    when i >= interval '2 hours' then interval '2 hours'
    when i >= interval '1 hour' then interval '1 hour'
    when i >= interval '30 min' then interval '30 min'
    when i >= interval '15 min' then interval '15 min'
    else interval '0' end
$$;
revoke all on function public._flex_floor(interval) from public, anon, authenticated;

-- Shape of a window request: a single-day round trip with a late-only, equal slack on both ends.
create or replace function public._duration_lock_shape_ok(
  p_trip_type public.trip_type, p_series_id uuid, p_depart timestamptz, p_return timestamptz,
  p_dep_early interval, p_dep_late interval, p_ret_early interval, p_ret_late interval
) returns boolean language sql immutable set search_path = public, pg_temp as $$
  select p_trip_type = 'round_trip' and p_series_id is null and p_depart is not null and p_return is not null
     and p_return > p_depart and p_dep_early = interval '0' and p_ret_early = interval '0'
     and p_dep_late > interval '0' and p_dep_late = p_ret_late
     and (p_depart at time zone 'Asia/Jerusalem')::date = (p_return at time zone 'Asia/Jerusalem')::date
$$;
revoke all on function public._duration_lock_shape_ok(public.trip_type, uuid, timestamptz, timestamptz, interval, interval, interval, interval)
  from public, anon, authenticated;

create or replace function public.assert_duration_lock(
  p_trip_type public.trip_type, p_series_id uuid, p_depart timestamptz, p_return timestamptz,
  p_dep_early interval, p_dep_late interval, p_ret_early interval, p_ret_late interval,
  p_depart_anchor public.time_anchor, p_return_anchor public.time_anchor
) returns void language plpgsql set search_path = public, pg_temp as $$
begin
  if not public._duration_lock_shape_ok(p_trip_type, p_series_id, p_depart, p_return, p_dep_early, p_dep_late, p_ret_early, p_ret_late)
     or p_depart_anchor <> 'leave' or p_return_anchor <> 'arrive' then
    raise exception 'invalid_duration_lock' using errcode = 'P0001';
  end if;
end $$;
revoke all on function public.assert_duration_lock(public.trip_type, uuid, timestamptz, timestamptz, interval, interval, interval, interval, public.time_anchor, public.time_anchor)
  from public, anon, authenticated;

create or replace function public.requests_duration_lock_guard() returns trigger
language plpgsql set search_path = public, pg_temp as $$
declare
  v_shift interval; v_late interval;
begin
  if not new.duration_locked then return new; end if;

  if not public._duration_lock_shape_ok(new.trip_type, new.series_id, new.depart_at, new.return_at,
       new.flex_depart_early, new.flex_depart_late, new.flex_return_early, new.flex_return_late) then
    new.duration_locked := false;
  elsif tg_op = 'UPDATE' and old.duration_locked and coalesce(current_setting('app.duration_lock_explicit', true), 'off') <> 'on' then
    if new.return_at - new.depart_at <> old.return_at - old.depart_at then
      -- the block's length changed outside submit_request: beyond the request's terms
      new.duration_locked := false;
    elsif new.depart_at <> old.depart_at and new.flex_depart_late = old.flex_depart_late and new.flex_return_late = old.flex_return_late then
      -- the whole block moved: the window's end stays where the member put it
      v_shift := new.depart_at - old.depart_at;
      v_late := greatest(old.flex_depart_late - v_shift, interval '0');
      v_late := least(floor(extract(epoch from v_late) / 900) * 900 * interval '1 second', interval '1 day');
      if v_late > interval '0' then
        new.flex_depart_late := v_late; new.flex_return_late := v_late;
      else
        new.duration_locked := false;
      end if;
    end if;
  end if;

  if not new.duration_locked then
    new.flex_depart_late := public._flex_floor(new.flex_depart_late);
    new.flex_return_late := public._flex_floor(new.flex_return_late);
  end if;
  return new;
end $$;
alter function public.requests_duration_lock_guard() owner to postgres;
revoke all on function public.requests_duration_lock_guard() from public, anon, authenticated;

-- Fires before requests_preserve_original_times / requests_shift_anchors (alphabetical) and only touches
-- duration_locked and the late flexes, which no other requests trigger reads.
create trigger requests_duration_lock_guard before insert or update on public.requests
  for each row execute function public.requests_duration_lock_guard();
