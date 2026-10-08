-- REQ §13.110 (e): the member's choice of the classic request form. Self-service: the existing
-- `profiles_update` policy lets a member update their own row and `profiles_protect_admin_fields()` only
-- locks is_admin/approval_status/email. `profiles` has explicit column grants for select
-- (20260910100000), so the new column needs its own.
alter table public.profiles add column classic_request_form boolean not null default false;
grant select (classic_request_form) on public.profiles to authenticated;
