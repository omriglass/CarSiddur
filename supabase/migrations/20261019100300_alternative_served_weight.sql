-- REQ §13.112 (a): a request served by its plan B counts as `alternativeServedWeight` (default 0.1) of a served
-- request -- in the fairness history (`fairness_stats`) and in the policy score (publication snapshots).
--
-- 1. alternative_served_weight(dept): the weight from the department's active policy (fairness rule param
--    `alternativeServedWeight`, 0..1), else 0.1. Internal helper (no grants).
-- 2. fairness_stats: the granted hours of a `served_by_alternative` request are multiplied by that weight.
--    Full create-or-replace of the function from 20261013160100 (signature unchanged).
-- 3. assert_publication_scores: a served request that is `served_by_alternative` may carry a `weight` (0..1) in its
--    score item; the served priority total is checked with that weight (every other request counts fully).
create or replace function public.alternative_served_weight(p_department_id uuid) returns numeric
language sql stable security definer set search_path = public, pg_temp as $$
  select coalesce((
    select least(1, greatest(0, (rule -> 'params' ->> 'alternativeServedWeight')::numeric))
    from public.policies p
    join public.policy_versions v on v.id = p.current_version_id
    cross join lateral jsonb_array_elements(v.rules) rule
    where p.is_active and (p.department_id = p_department_id or p.department_id is null)
      and rule ->> 'type' = 'fairness' and rule -> 'params' ? 'alternativeServedWeight'
    order by (p.department_id is null), p.id limit 1
  ), 0.1)
$$;
revoke all on function public.alternative_served_weight(uuid) from public, anon, authenticated;

create or replace function public.fairness_stats(p_department_id uuid, p_week_start date, p_lookback_weeks integer)
returns table(profile_id uuid, granted_hours numeric)
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_alt numeric;
begin
  if not public.can_manage_week(p_department_id, p_week_start) then
    raise exception 'not_authorized' using errcode='P0001';
  end if;
  v_alt := public.alternative_served_weight(p_department_id);

  return query
    select p.id,
      coalesce(sum(
        coalesce(
          extract(epoch from (q.return_at - q.depart_at)) / 3600.0,
          (select sum(extract(epoch from (r.ends_at-r.starts_at)) / 3600.0)
           from public.ride_requests rr join public.rides r on r.id=rr.ride_id
           where rr.request_id=q.id and r.status<>'cancelled')
        ) * case when q.served_by_alternative then v_alt else 1 end
      ) filter (where q.status in ('assigned','merged')), 0)::numeric as granted_hours
    from public.department_members dm
    join public.profiles p on p.id=dm.profile_id
    left join public.requests q on q.requester_id=p.id and q.department_id=p_department_id
      and q.week_start >= p_week_start-(p_lookback_weeks*7) and q.week_start<p_week_start
    where dm.department_id=p_department_id and dm.removed_at is null
    group by p.id;
end;
$$;

create or replace function public.assert_publication_scores(p_department_id uuid, p_week_start date, p_scores jsonb)
returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare profile jsonb; item jsonb; n int; served_count int; total numeric; served_total numeric; actual_served boolean;
  v_alt boolean; v_weight numeric;
begin
  if jsonb_typeof(p_scores) is distinct from 'array' then raise exception 'invalid_publication_scores'; end if;
  if (select count(distinct x->>'profile_id') from jsonb_array_elements(p_scores) x)<>jsonb_array_length(p_scores) then raise exception 'invalid_publication_scores'; end if;
  for profile in select * from jsonb_array_elements(p_scores) loop
    if jsonb_typeof(profile->'requests') is distinct from 'array' then raise exception 'invalid_publication_scores'; end if;
    n:=0;served_count:=0;total:=0;served_total:=0;
    for item in select * from jsonb_array_elements(profile->'requests') loop
      if jsonb_typeof(item->'score') is distinct from 'number' or jsonb_typeof(item->'served') is distinct from 'boolean' then raise exception 'invalid_publication_scores'; end if;
      select q.served_by_alternative into v_alt from public.requests q where q.id=(item->>'request_id')::uuid and q.requester_id=(profile->>'profile_id')::uuid
        and q.department_id=p_department_id and q.week_start=p_week_start and q.status not in ('draft','withdrawn','cancelled');
      if not found then raise exception 'invalid_publication_scores'; end if;
      select exists(select 1 from public.ride_requests rr join public.rides r on r.id=rr.ride_id where rr.request_id=(item->>'request_id')::uuid and r.status<>'cancelled' and not r.needs_driver) into actual_served;
      if actual_served is distinct from (item->>'served')::boolean then raise exception 'invalid_publication_scores'; end if;
      -- REQ §13.112 (a): a plan-B-served request counts `weight` (0..1, from the policy) of its priority; all others count fully.
      v_weight := 1;
      if v_alt and item ? 'weight' then
        if jsonb_typeof(item->'weight') is distinct from 'number' then raise exception 'invalid_publication_scores'; end if;
        v_weight := (item->>'weight')::numeric;
        if v_weight < 0 or v_weight > 1 then raise exception 'invalid_publication_scores'; end if;
      elsif item ? 'weight' and (item->>'weight')::numeric is distinct from 1 then
        raise exception 'invalid_publication_scores';
      end if;
      n:=n+1;total:=total+(item->>'score')::numeric;
      if actual_served then served_count:=served_count+1;served_total:=served_total+(item->>'score')::numeric*v_weight; end if;
    end loop;
    if (profile->>'request_count')::int is distinct from n or (profile->>'served_count')::int is distinct from served_count
      or abs(coalesce((profile->>'priority_total')::numeric,'Infinity'::numeric)-total)>0.000001*greatest(n,1)
      or abs(coalesce((profile->>'served_priority_total')::numeric,'Infinity'::numeric)-served_total)>0.000001*greatest(n,1) then raise exception 'invalid_publication_scores'; end if;
  end loop;
  if exists(select 1 from public.requests q where q.department_id=p_department_id and q.week_start=p_week_start and q.status not in ('draft','withdrawn','cancelled')
    and (select count(*) from jsonb_array_elements(p_scores) score_profile cross join lateral jsonb_array_elements(score_profile->'requests') score_item where (score_item->>'request_id')::uuid=q.id)<>1
  ) then raise exception 'invalid_publication_scores'; end if;
end $$;
