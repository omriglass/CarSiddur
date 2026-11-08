-- PF1: the requests list (board, siddur, /my) spent ~20 ms per 110 rows in requests_select, calling
-- is_request_companion(id) and is_sadran(...) for every row before reaching is_admin(). Same rule, cheaper order:
-- the per-statement checks first (auth.uid(), is_admin() and is_approved() as InitPlans), then the per-row ones,
-- the companion lookup last but one. Measured on the 2026-11-08 production copy: an admin's read 20 ms → <1 ms.
alter policy requests_select on public.requests
  using (
    requester_id = (select auth.uid())
    or filed_by = (select auth.uid())
    or (select public.is_admin())
    or public.is_sadran(department_id, week_start)
    or public.is_request_companion(id)
    or ((select public.is_approved()) and public.is_week_public(department_id, week_start)
        and public.request_served_by_public_ride(id))
  );
