-- Remove PL/pgSQL/table alias ambiguity; allow score aggregation rounding. REQ §5.2, §7.
create or replace function public.withdraw_all_requests(p_department_id uuid,p_week_start date) returns int
security definer set search_path = public, pg_temp language plpgsql as $$
declare w public.weeks%rowtype; n int; request_row record;
begin
  if not public.member_of(p_department_id) then raise exception 'not_authorized'; end if;
  select * into w from public.weeks where department_id=p_department_id and week_start=p_week_start for update;
  if not found or w.phase not in ('open','solving') or now()<w.open_at or now()>w.close_at then raise exception 'request_window_closed'; end if;
  for request_row in select id from public.requests where department_id=p_department_id and week_start=p_week_start and requester_id=(select auth.uid()) and status not in ('withdrawn','cancelled') for update loop
    perform public.release_request_draft_rides(request_row.id);
  end loop;
  perform set_config('app.audit_reason','withdraw_all_requests',true);
  update public.requests q set status='withdrawn',status_reason='WITHDRAWN_BY_MEMBER'
  where department_id=p_department_id and week_start=p_week_start and requester_id=(select auth.uid())
    and status not in ('withdrawn','cancelled')
    and not exists(select 1 from public.ride_requests rr join public.rides r on r.id=rr.ride_id where rr.request_id=q.id and r.status<>'cancelled');
  get diagnostics n=row_count;
  return n;
end $$;
revoke execute on function public.withdraw_all_requests(uuid,date) from public,anon;
grant execute on function public.withdraw_all_requests(uuid,date) to authenticated;

create or replace function public.assert_publication_scores(p_department_id uuid,p_week_start date,p_scores jsonb) returns void
security definer set search_path = public, pg_temp language plpgsql as $$
declare profile jsonb; item jsonb; n int; served_count int; total numeric; served_total numeric; actual_served boolean;
begin
  if jsonb_typeof(p_scores) is distinct from 'array' then raise exception 'invalid_publication_scores'; end if;
  if (select count(distinct x->>'profile_id') from jsonb_array_elements(p_scores) x)<>jsonb_array_length(p_scores) then raise exception 'invalid_publication_scores'; end if;
  for profile in select * from jsonb_array_elements(p_scores) loop
    if jsonb_typeof(profile->'requests') is distinct from 'array' then raise exception 'invalid_publication_scores'; end if;
    n:=0;served_count:=0;total:=0;served_total:=0;
    for item in select * from jsonb_array_elements(profile->'requests') loop
      if jsonb_typeof(item->'score') is distinct from 'number' or jsonb_typeof(item->'served') is distinct from 'boolean' then raise exception 'invalid_publication_scores'; end if;
      if not exists(select 1 from public.requests q where q.id=(item->>'request_id')::uuid and q.requester_id=(profile->>'profile_id')::uuid
        and q.department_id=p_department_id and q.week_start=p_week_start and q.status not in ('draft','withdrawn','cancelled')) then raise exception 'invalid_publication_scores'; end if;
      select exists(select 1 from public.ride_requests rr join public.rides r on r.id=rr.ride_id where rr.request_id=(item->>'request_id')::uuid and r.status<>'cancelled') into actual_served;
      if actual_served is distinct from (item->>'served')::boolean then raise exception 'invalid_publication_scores'; end if;
      n:=n+1;total:=total+(item->>'score')::numeric;
      if actual_served then served_count:=served_count+1;served_total:=served_total+(item->>'score')::numeric; end if;
    end loop;
    if (profile->>'request_count')::int is distinct from n or (profile->>'served_count')::int is distinct from served_count
      or abs(coalesce((profile->>'priority_total')::numeric,'Infinity'::numeric)-total)>0.000001*greatest(n,1)
      or abs(coalesce((profile->>'served_priority_total')::numeric,'Infinity'::numeric)-served_total)>0.000001*greatest(n,1) then raise exception 'invalid_publication_scores'; end if;
  end loop;
  if exists(select 1 from public.requests q where q.department_id=p_department_id and q.week_start=p_week_start and q.status not in ('draft','withdrawn','cancelled')
    and (select count(*) from jsonb_array_elements(p_scores) score_profile cross join lateral jsonb_array_elements(score_profile->'requests') score_item where (score_item->>'request_id')::uuid=q.id)<>1
  ) then raise exception 'invalid_publication_scores'; end if;
end $$;
revoke execute on function public.assert_publication_scores(uuid,date,jsonb) from public,anon,authenticated;
