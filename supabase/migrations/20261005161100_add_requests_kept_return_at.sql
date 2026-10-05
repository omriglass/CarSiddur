-- REQ §13.93/§13.96 follow-up: a request keeps its last real return time when switched to one-way (requests_return_presence_ck
-- forces return_at null for one_way_to), so switching back restores it.
alter table public.requests add column if not exists kept_return_at timestamptz;
comment on column public.requests.kept_return_at is
  'Last real return time while return_at is cleared by a switch to one-way; restored by set_request_trip_type / submit_request, cleared once return_at is stored again.';
