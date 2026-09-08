-- A published day is immutable, but a member may still enter the normal
-- freed-slot queue for a matching time/destination. The request is created by
-- the existing validated path, then explicitly marked waitlisted.
create or replace function public.enter_waiting_list(p_payload jsonb) returns jsonb
security definer set search_path=public,pg_temp language plpgsql as $$
declare
  result jsonb;
  request_id uuid;
  request_row public.requests%rowtype;
  week_row public.weeks%rowtype;
  request_day date;
begin
  if p_payload ? 'request_id' then raise exception 'request_not_editable' using errcode='P0001'; end if;
  result := public.submit_request(p_payload - 'waitlist');
  request_id := (result->>'request_id')::uuid;
  select * into request_row from public.requests where id=request_id for update;
  select * into week_row from public.weeks where department_id=request_row.department_id and week_start=request_row.week_start;
  request_day := (coalesce(request_row.depart_at,request_row.return_at) at time zone 'Asia/Jerusalem')::date;
  if week_row.phase not in ('published','live') or not request_day=any(week_row.published_days) then
    raise exception 'request_window_closed' using errcode='P0001';
  end if;
  perform set_config('app.system_status_transition','on',true);
  update public.requests set status='waitlisted', status_reason='WAITLISTED_PUBLISHED_DAY' where id=request_id;
  perform set_config('app.system_status_transition','off',true);
  return result || jsonb_build_object('status','waitlisted','reason','WAITLISTED_PUBLISHED_DAY');
end;
$$;

revoke execute on function public.enter_waiting_list(jsonb) from public,anon;
grant execute on function public.enter_waiting_list(jsonb) to authenticated;
