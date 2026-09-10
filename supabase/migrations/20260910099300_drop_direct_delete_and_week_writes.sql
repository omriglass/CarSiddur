-- Admins could hard-delete rides and requests from the client, and Sadranim could write
-- `weeks` directly (docs/HARDENING_2026-09.md §1.5, §2.2).
-- ride_requests cascades on delete, so a deleted ride left its requests assigned with no
-- ride and a deleted driver request left a ride with no driver row. weeks_update let
-- published_days be set outside publish_siddur(). The frontend never used any of these
-- policies: rides are cancelled, never deleted; requests are withdrawn; weeks change only
-- through open_week / set_week_phase / publish_siddur / reopen_week / ensure_department_weeks.

drop policy if exists rides_delete on public.rides;
drop policy if exists requests_delete on public.requests;
drop policy if exists weeks_insert on public.weeks;
drop policy if exists weeks_update on public.weeks;
drop policy if exists weeks_delete on public.weeks;
