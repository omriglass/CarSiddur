-- Owner 2026-10-11: the member's default view of the "my rides" screen (`/my`): the list (false, default) or the
-- week grid with one column per day (true). Self-service like `classic_request_form`: the existing `profiles_update`
-- policy lets a member update their own row and `profiles_protect_admin_fields()` only locks is_admin/approval_status/
-- email. `profiles` has explicit column grants for select (20260910100000), so the new column needs its own.
alter table public.profiles add column my_rides_week_view boolean not null default false;
grant select (my_rides_week_view) on public.profiles to authenticated;
