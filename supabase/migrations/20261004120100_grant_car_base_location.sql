-- REQ §13.93 follow-up: `v_car_locations` (security_invoker) calls car_base_location() per
-- row, so a signed-in member reading the view needs EXECUTE on it — without it the siddur
-- and board fail with `permission denied for function car_base_location` (found by the
-- Playwright run, 2026-10-04). The helper only returns `cars.base_location_id` (readable
-- across departments, rls_smoke TEST 18) or the owner's default origin / department home,
-- so it is classified `read-helper` in department_isolation.sql.
grant execute on function public.car_base_location(uuid) to authenticated;
