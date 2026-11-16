-- REQ item 246 (LT1): a stop may carry one fixed hour (arrive by / leave at) with flexibility,
-- and an optional stay. Written only by replace_request_stops (submit_request's `stops` payload).
alter table public.request_stops
  add column fixed_anchor public.time_anchor,
  add column fixed_at timestamptz,
  add column flex_minutes smallint not null default 0,
  add column stay_minutes smallint;

alter table public.request_stops
  add constraint request_stops_fixed_pair_ck check ((fixed_anchor is null) = (fixed_at is null)),
  add constraint request_stops_fixed_grid_ck check (fixed_at is null or (extract(epoch from fixed_at)::bigint % 300) = 0),
  add constraint request_stops_flex_ck check (flex_minutes in (0, 10, 15, 30, 60) and (fixed_anchor is not null or flex_minutes = 0)),
  add constraint request_stops_stay_ck check (stay_minutes is null or stay_minutes between 1 and 1440);

comment on column public.request_stops.fixed_anchor is 'REQ item 246: arrive = arrive by fixed_at (earlier places timed backwards); leave = leave at fixed_at (later places timed forwards); null = worked out.';
comment on column public.request_stops.flex_minutes is 'REQ item 246: how many minutes the fixed hour may slip (arrive later / leave later).';
comment on column public.request_stops.stay_minutes is 'REQ item 246: minutes there as the member gave them; null = worked out (department stop_minutes for a short stop).';
