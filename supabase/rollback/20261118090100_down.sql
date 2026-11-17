-- Down for 20261118090100_two_hours_per_way: put back "one hour per way". A request that kept both hours loses
-- its second (stated) hour first, so the old checks hold; its car times are unchanged.
update public.requests set arrive_by = null where arrive_by is not null and depart_anchor <> 'arrive';
update public.requests set leave_dest_at = null where leave_dest_at is not null and return_anchor <> 'leave';
update public.request_templates set arrive_by_time = null where arrive_by_time is not null and depart_anchor <> 'arrive';
update public.request_templates set leave_dest_time = null where leave_dest_time is not null and return_anchor <> 'leave';
alter table public.requests add constraint requests_arrive_by_anchor_ck
  check (arrive_by is null or depart_anchor = 'arrive');
alter table public.requests add constraint requests_leave_dest_anchor_ck
  check (leave_dest_at is null or return_anchor = 'leave');
alter table public.request_templates add constraint request_templates_arrive_by_anchor_ck
  check (arrive_by_time is null or depart_anchor = 'arrive');
alter table public.request_templates add constraint request_templates_leave_dest_anchor_ck
  check (leave_dest_time is null or return_anchor = 'leave');
