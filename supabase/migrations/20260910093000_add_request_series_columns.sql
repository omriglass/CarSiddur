-- REQ §13.77 — multi-day requests ("series").
-- A member reserves a car from a departure day/time to a return day/time on a LATER day.
-- It is stored as one linked request per calendar day sharing a `series_id`:
--   first day  depart -> 23:59:00
--   middle day 00:00  -> 23:59:00
--   last day   00:00  -> return
-- so every existing single-day invariant (assert_same_day_window, requests_within_week,
-- rides_within_week, assert_ride_request_day) keeps holding leg by leg, and a leg that
-- falls in the next week is an ordinary request of that week.
--
-- This migration only adds the columns/indexes. The series-aware constraints, RPCs and
-- cascades follow in 20260910093100..20260910093700.

alter table public.requests
  add column series_id uuid,
  add column series_index smallint,
  add column series_count smallint;

alter table public.requests add constraint requests_series_ck check (
  (series_id is null and series_index is null and series_count is null)
  or (series_id is not null and series_index is not null and series_count is not null
      and series_count >= 2 and series_index >= 1 and series_index <= series_count));

create index requests_series_idx on public.requests (series_id, series_index) where series_id is not null;

-- Denormalized onto the ride so `rides_before_write()` (a BEFORE INSERT trigger, i.e. long
-- before any ride_requests row exists) can recognise two legs of the same series at the
-- midnight seam, and so the board/siddur can render a multi-day booking as one block.
alter table public.rides add column series_id uuid;
create index rides_series_idx on public.rides (series_id, starts_at) where series_id is not null;

-- Backstop for ride-writing paths that do not set rides.series_id themselves
-- (`edit_ride` re-serving an existing ride). The three paths that create series rides —
-- `place_series`, `move_series`, `apply_solver_result` — set it inline at INSERT time,
-- which is what the turnaround carve-out needs. Updating `series_id` alone does not fire
-- `rides_before_write` (that trigger lists its own UPDATE OF columns), so this cannot loop.
create function public.ride_requests_sync_series() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_series uuid;
begin
  select q.series_id into v_series from public.requests q where q.id = new.request_id and q.series_id is not null;
  if v_series is not null then
    update public.rides set series_id = v_series where id = new.ride_id and series_id is distinct from v_series;
  end if;
  return new;
end $$;

create trigger ride_requests_sync_series after insert on public.ride_requests
  for each row execute function public.ride_requests_sync_series();
