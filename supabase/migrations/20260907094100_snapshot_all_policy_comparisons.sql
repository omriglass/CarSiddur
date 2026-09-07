-- Compare the final board against every applicable policy profile, including inactive profiles.
-- REQ §7; TODO policy-profile comparison before publishing.
create function public.assert_publication_scores(p_department_id uuid,p_week_start date,p_scores jsonb) returns void
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
      or abs(coalesce((profile->>'priority_total')::numeric,'Infinity'::numeric)-total)>0.000001
      or abs(coalesce((profile->>'served_priority_total')::numeric,'Infinity'::numeric)-served_total)>0.000001 then raise exception 'invalid_publication_scores'; end if;
  end loop;
  if exists(select 1 from public.requests q where q.department_id=p_department_id and q.week_start=p_week_start and q.status not in ('draft','withdrawn','cancelled')
    and (select count(*) from jsonb_array_elements(p_scores) score_profile cross join lateral jsonb_array_elements(score_profile->'requests') score_item where (score_item->>'request_id')::uuid=q.id)<>1
  ) then raise exception 'invalid_publication_scores'; end if;
end $$;
revoke execute on function public.assert_publication_scores(uuid,date,jsonb) from public,anon,authenticated;
drop function public.publish_siddur(uuid,date,jsonb,text);
create or replace function public.publish_siddur(p_department_id uuid, p_week_start date, p_profile_scores jsonb default '[]', p_expected_fingerprint text default null, p_policy_scores jsonb default '[]') returns uuid
security definer set search_path = public, pg_temp
language plpgsql as $$
declare
  v_snapshot jsonb;
  v_version_id uuid := gen_random_uuid();
  v_prev record;
  v_phase public.week_phase;
  v_req record;
  v_notified int := 0;
  v_prev_status text;
  v_event public.notification_event;
  policy_score jsonb;
  n int; served_n int; total numeric; served_total numeric;
begin
  if not public.can_manage_week(p_department_id, p_week_start) then
    raise exception 'not_authorized' using errcode = 'P0001';
  end if;

  perform 1 from public.weeks where department_id=p_department_id and week_start=p_week_start for update;
  if not found then raise exception 'week_not_open'; end if;
  if exists(select 1 from public.weeks where department_id=p_department_id and week_start=p_week_start and phase='archived') then raise exception 'week_archived'; end if;
  -- Lock publication inputs while the snapshot and scores are checked and saved.
  lock table public.requests,public.rides,public.ride_requests,public.policies,public.department_settings,public.cars,public.car_seat_configs,public.car_maintenance_blocks,public.destinations in share mode;
  if p_expected_fingerprint is not null and p_expected_fingerprint<>public.publish_scores_fingerprint(p_department_id,p_week_start) then
    raise exception 'stale_input' using errcode='P0409';
  end if;
  if jsonb_typeof(p_profile_scores) is distinct from 'array' then raise exception 'invalid_publication_scores'; end if;
  if p_expected_fingerprint is null then raise exception 'stale_input' using errcode='P0409'; end if;
  if exists(select 1 from jsonb_array_elements(p_profile_scores) score where not exists (
    select 1 from public.requests q where q.requester_id=(score->>'profile_id')::uuid and q.department_id=p_department_id and q.week_start=p_week_start
  )) or exists (
    select 1 from public.requests q where q.department_id=p_department_id and q.week_start=p_week_start and q.status not in ('draft','withdrawn','cancelled')
      and (select count(*) from jsonb_array_elements(p_profile_scores) score cross join lateral jsonb_array_elements(score->'requests') item
           where (score->>'profile_id')::uuid=q.requester_id and (item->>'request_id')::uuid=q.id and jsonb_typeof(item->'score')='number')<>1
  ) or exists (
    select 1 from jsonb_array_elements(p_profile_scores) score cross join lateral jsonb_array_elements(score->'requests') item
    where not exists(select 1 from public.requests q where q.id=(item->>'request_id')::uuid and q.requester_id=(score->>'profile_id')::uuid
      and q.department_id=p_department_id and q.week_start=p_week_start and q.status not in ('draft','withdrawn','cancelled'))
  ) then raise exception 'invalid_publication_scores'; end if;
  perform public.assert_publication_scores(p_department_id,p_week_start,p_profile_scores);
  if jsonb_typeof(p_policy_scores) is distinct from 'array' then raise exception 'invalid_publication_scores'; end if;
  if (select count(distinct x->>'policy_id') from jsonb_array_elements(p_policy_scores) x)<>jsonb_array_length(p_policy_scores) then raise exception 'invalid_publication_scores'; end if;
  if exists(select 1 from public.policies p where (department_id=p_department_id or department_id is null) and current_version_id is not null
    and not exists(select 1 from jsonb_array_elements(p_policy_scores) x where (x->>'policy_id')::uuid=p.id and (x->>'policy_version_id')::uuid=p.current_version_id)
  ) then raise exception 'invalid_publication_scores'; end if;
  for policy_score in select * from jsonb_array_elements(p_policy_scores) loop
    if not exists(select 1 from public.policies p where p.id=(policy_score->>'policy_id')::uuid and p.current_version_id=(policy_score->>'policy_version_id')::uuid
      and (p.department_id=p_department_id or p.department_id is null)) then raise exception 'invalid_publication_scores'; end if;
    perform public.assert_publication_scores(p_department_id,p_week_start,policy_score->'profiles');
    select coalesce(sum((x->>'request_count')::int),0),coalesce(sum((x->>'served_count')::int),0),
      coalesce(sum((x->>'priority_total')::numeric),0),coalesce(sum((x->>'served_priority_total')::numeric),0)
      into n,served_n,total,served_total from jsonb_array_elements(policy_score->'profiles') x;
    if (policy_score->>'request_count')::int is distinct from n or (policy_score->>'served_count')::int is distinct from served_n
      or abs(coalesce((policy_score->>'priority_total')::numeric,'Infinity'::numeric)-total)>0.000001
      or abs(coalesce((policy_score->>'served_priority_total')::numeric,'Infinity'::numeric)-served_total)>0.000001
    then raise exception 'invalid_publication_scores'; end if;
  end loop;
  if exists(select 1 from public.ride_change_requests where department_id=p_department_id and week_start=p_week_start and status='pending' and starts_at>now()) then raise exception 'pending_ride_changes'; end if;
  select * into v_prev from public.siddur_versions
  where department_id = p_department_id and week_start = p_week_start order by version_no desc limit 1;

  select jsonb_build_object(
    'profile_scores',p_profile_scores,
    'policy_scores',p_policy_scores,
    'policy_version_id',(select current_version_id from public.policies where is_active and (department_id=p_department_id or department_id is null) order by department_id nulls last limit 1),
    'scores_fingerprint',p_expected_fingerprint,
    'rides', (select coalesce(jsonb_agg(to_jsonb(r)), '[]') from public.rides r
              where r.department_id = p_department_id and r.week_start = p_week_start and r.status <> 'cancelled'),
    'requests', (select coalesce(jsonb_agg(jsonb_build_object(
                    'id', q.id, 'requester_id', q.requester_id, 'status', q.status, 'status_reason', q.status_reason)), '[]')
                 from public.requests q where q.department_id = p_department_id and q.week_start = p_week_start),
    'cars', (select coalesce(jsonb_agg(to_jsonb(c)), '[]') from public.cars c where c.department_id = p_department_id),
    'blocks', (select coalesce(jsonb_agg(to_jsonb(b)), '[]') from public.car_maintenance_blocks b where b.department_id = p_department_id)
  ) into v_snapshot;

  perform set_config('app.audit_reason', 'publish_siddur', true);

  -- Compute notified_count up front (§ above) — enqueue_notification writes are safe to
  -- run before the siddur_versions row exists since this whole RPC is one transaction:
  -- either everything commits together or everything rolls back together.
  for v_req in
    select id, requester_id, status from public.requests
    where department_id = p_department_id and week_start = p_week_start and status not in ('draft', 'withdrawn')
  loop
    v_prev_status := null;
    if v_prev is not null then
      select elem ->> 'status' into v_prev_status
      from jsonb_array_elements(v_prev.snapshot -> 'requests') elem
      where (elem ->> 'id')::uuid = v_req.id;
    end if;

    if v_prev is null then
      v_event := 'published';
    elsif v_prev_status is distinct from v_req.status::text then
      v_event := 'outcome_changed';
    else
      continue;
    end if;

    perform public.enqueue_notification(v_req.requester_id, v_event, p_department_id, p_week_start,
      '{}'::jsonb, jsonb_build_object('request_id', v_req.id), format('%s:%s:%s', v_event, v_version_id, v_req.id));
    v_notified := v_notified + 1;
  end loop;

  insert into public.siddur_versions (id, department_id, week_start, snapshot, published_by, notified_count)
  values (v_version_id, p_department_id, p_week_start, v_snapshot, (select auth.uid()), v_notified);

  perform set_config('app.in_publish', 'on', true);

  v_phase := case when p_week_start <= public.current_week_start() then 'live' else 'published' end;

  update public.weeks set published_version_id = v_version_id, published_at = now(), phase = v_phase
  where department_id = p_department_id and week_start = p_week_start;

  update public.rides set status = 'confirmed'
  where department_id = p_department_id and week_start = p_week_start and status = 'draft';

  perform set_config('app.in_publish', 'off', true);

  return v_version_id;
end;
$$;

revoke execute on function public.publish_siddur(uuid,date,jsonb,text,jsonb) from public,anon;
grant execute on function public.publish_siddur(uuid,date,jsonb,text,jsonb) to authenticated;
