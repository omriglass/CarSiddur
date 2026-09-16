-- REQ §13.88/§13.89 follow-up (found by e2e/board.spec.ts "bug #4" after the solver started
-- emitting driverless assignments): the solver now places (a) a non-driver's round trip as a
-- ride WITHOUT a driver (`PLACED_NEEDS_DRIVER`) and (b) an automatic missing-driver
-- relocation next to a lone relay leg (`PLACED_RELAY_SOLO`). apply_solver_result() inserted
-- rides with `(v_ride ->> 'driver_id')::uuid` — the client sent "" for "no driver", which
-- fails with 22P02 ("invalid input syntax for type uuid") before anything is written — and
-- never set `needs_driver`/`auto_relocation`, so even a null driver would have tripped
-- rides_reservation_notes_ck (driver or needs_driver or notes).
--
-- Patched in place (pg_get_functiondef + replace, same technique as 20260910096000 /
-- 20260915110000) so the rest of the function stays byte-identical:
--   * driver_id: nullif(…,'')::uuid — "" and null both mean "no driver";
--   * needs_driver := driver_id is null;
--   * auto_relocation := coalesce(payload flag, false) — the client marks the solver's
--     healing ride so assert_car_chain() treats it like its own relocations (reused while
--     needed, cancelled when obsolete, claimable via claim_ride_driver).
do $migration$
declare
  def text;
  old_cols text := $old$      driver_id, status, is_pinned, pin_reason, created_by_solver_run_id, created_by, overflow_allowed, series_id)$old$;
  new_cols text := $new$      driver_id, status, is_pinned, pin_reason, created_by_solver_run_id, created_by, overflow_allowed, series_id,
      needs_driver, auto_relocation)$new$;
  old_driver text := $old$      (v_ride ->> 'driver_id')::uuid, 'draft',$old$;
  new_driver text := $new$      nullif(v_ride ->> 'driver_id', '')::uuid, 'draft',$new$;
  old_tail text := $old$coalesce((v_ride ->> 'overflow_allowed')::boolean, false), v_series_id)
    returning id into v_ride_id;$old$;
  new_tail text := $new$coalesce((v_ride ->> 'overflow_allowed')::boolean, false), v_series_id,
      nullif(v_ride ->> 'driver_id', '') is null, coalesce((v_ride ->> 'auto_relocation')::boolean, false))
    returning id into v_ride_id;$new$;
begin
  def := pg_get_functiondef('public.apply_solver_result(uuid,date,jsonb)'::regprocedure);
  if strpos(def, old_cols) = 0 then raise exception 'unexpected_apply_solver_result_columns'; end if;
  if strpos(def, old_driver) = 0 then raise exception 'unexpected_apply_solver_result_driver'; end if;
  if strpos(def, old_tail) = 0 then raise exception 'unexpected_apply_solver_result_tail'; end if;
  def := replace(def, old_cols, new_cols);
  def := replace(def, old_driver, new_driver);
  def := replace(def, old_tail, new_tail);
  execute def;
end;
$migration$;

-- rides_location_ends (20260907090800): "a ride whose origin/destination is not home must
-- have at least one served relay leg" — true for a member's leg, not for an automatic
-- relocation, which by definition moves the car between two places and serves nobody. It is
-- a DEFERRABLE INITIALLY DEFERRED constraint trigger, so the transactional SQL suites (which
-- never commit) did not fire it; a real request did, on commit, for both the DB's own
-- relocations (20260915110000) and the solver's (above). Exempt auto_relocation rows.
-- (supabase/tests/car_chain_relocation.sql and solve_semantics.sql now run with
-- `set constraints all immediate` so deferred triggers fire inside the rolled-back suite.)
create or replace function public.rides_location_ends() returns trigger
security definer set search_path = public, pg_temp
language plpgsql as $$
declare v_home uuid; r public.rides%rowtype;
begin
  -- Deferred trigger: `new` is the row image of the *triggering* statement. Re-read the
  -- current row so a ride inserted and then cancelled/edited before the check point is judged
  -- by what it is now (one transaction with several ride writes — a test suite, a batch RPC).
  select * into r from public.rides where id = new.id;
  if not found then return null; end if;
  -- An automatic relocation moves the car between two places and serves nobody; a cancelled
  -- ride has no location semantics at all.
  if r.auto_relocation or r.status = 'cancelled' then
    return null;
  end if;
  select d.home_destination_id into v_home from public.departments d where d.id = r.department_id;
  if r.origin_id = v_home and r.destination_id = v_home then
    return null;
  end if;
  if not exists (select 1 from public.ride_requests rr where rr.ride_id = r.id) then
    raise exception 'ride_location_ends_invalid' using errcode = 'P0001',
      detail = 'a ride whose origin/destination is not home must have at least one served relay leg';
  end if;
  return null;
end;
$$;
