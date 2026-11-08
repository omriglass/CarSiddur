-- Down script for 20261108190000_ride_change_shorten_columns.sql (REQ §13.203).
-- Request changes asked for a new request have no ride to keep: they go, then ride_id is required again.
-- Run after rolling the functions back (they read the new columns).
begin;
delete from public.ride_change_requests where request_id is not null;
drop index if exists public.ride_change_requests_request_id_idx;
drop index if exists public.ride_change_one_pending_request;
alter table public.ride_change_requests drop constraint if exists ride_change_requests_target;
alter table public.ride_change_requests drop column if exists talked;
alter table public.ride_change_requests drop column if exists request_id;
alter table public.ride_change_requests alter column ride_id set not null;
alter table public.ride_change_parties drop column if exists new_ends_at;
alter table public.ride_change_parties drop column if exists new_starts_at;
alter table public.ride_change_parties drop column if exists cut;
commit;
