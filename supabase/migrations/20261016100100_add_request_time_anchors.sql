-- REQ §13.110 (b): the request stores which way each end was entered and the time the member typed.
-- `depart_at` / `return_at` stay the car's times and the only source of truth for placement;
-- `arrive_by` ("be there by") and `leave_dest_at` ("leave there at") are display + edit-reopen data.
-- `return_at` is "arrives home" (REQ §5.1), so a `return_anchor = 'arrive'` request has no extra time.
alter table public.requests
  add column depart_anchor public.time_anchor not null default 'leave',
  add column arrive_by timestamptz,
  add column return_anchor public.time_anchor not null default 'arrive',
  add column leave_dest_at timestamptz,
  add constraint requests_arrive_by_anchor_ck check (arrive_by is null or depart_anchor = 'arrive'),
  add constraint requests_leave_dest_anchor_ck check (leave_dest_at is null or return_anchor = 'leave'),
  add constraint requests_arrive_by_qh_ck check (public.is_quarter_hour(arrive_by)),
  add constraint requests_leave_dest_qh_ck check (public.is_quarter_hour(leave_dest_at));

-- Templates keep their own times as (dow, time) (DATA_MODEL §3.6); the entered times follow the
-- same representation: a time of day, placed on depart_dow / return_dow when a suggestion is built.
alter table public.request_templates
  add column depart_anchor public.time_anchor not null default 'leave',
  add column arrive_by_time time,
  add column return_anchor public.time_anchor not null default 'arrive',
  add column leave_dest_time time,
  add constraint request_templates_arrive_by_anchor_ck check (arrive_by_time is null or depart_anchor = 'arrive'),
  add constraint request_templates_leave_dest_anchor_ck check (leave_dest_time is null or return_anchor = 'leave'),
  add constraint request_templates_arrive_by_qh_ck check (arrive_by_time is null or extract(minute from arrive_by_time)::int % 15 = 0),
  add constraint request_templates_leave_dest_qh_ck check (leave_dest_time is null or extract(minute from leave_dest_time)::int % 15 = 0);
