-- Save freshly computed per-profile policy scores alongside each immutable publication.
-- REQ §7; TODO publish scoring.
create function public.publish_scores_fingerprint(p_department_id uuid,p_week_start date) returns text
security definer stable set search_path = public, pg_temp language plpgsql as $$
begin
  if not public.can_manage_week(p_department_id,p_week_start) then raise exception 'not_authorized'; end if;
  return md5(jsonb_build_object(
    'week',(select to_jsonb(w) from public.weeks w where department_id=p_department_id and week_start=p_week_start),
    'requests',(select jsonb_agg(to_jsonb(q) order by id) from public.requests q where department_id=p_department_id),
    'rides',(select jsonb_agg(to_jsonb(r) order by id) from public.rides r where department_id=p_department_id),
    'served',(select jsonb_agg(to_jsonb(rr) order by rr.ride_id,rr.request_id,rr.leg) from public.ride_requests rr join public.rides r on r.id=rr.ride_id where r.department_id=p_department_id),
    'policies',(select jsonb_agg(to_jsonb(p) order by id) from public.policies p where department_id=p_department_id or department_id is null),
    'settings',(select to_jsonb(s) from public.department_settings s where department_id=p_department_id),
    'cars',(select jsonb_agg(to_jsonb(c) order by id) from public.cars c where department_id=p_department_id),
    'seats',(select jsonb_agg(to_jsonb(s) order by s.id) from public.car_seat_configs s join public.cars c on c.id=s.car_id where c.department_id=p_department_id),
    'blocks',(select jsonb_agg(to_jsonb(b) order by id) from public.car_maintenance_blocks b where department_id=p_department_id),
    'destinations',(select jsonb_agg(to_jsonb(d) order by id) from public.destinations d)
  )::text);
end $$;
revoke execute on function public.publish_scores_fingerprint(uuid,date) from public,anon;
grant execute on function public.publish_scores_fingerprint(uuid,date) to authenticated;
drop function public.publish_siddur(uuid,date);
create or replace function public.publish_siddur(p_department_id uuid, p_week_start date, p_profile_scores jsonb default '[]', p_expected_fingerprint text default null) returns uuid
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
  select * into v_prev from public.siddur_versions
  where department_id = p_department_id and week_start = p_week_start order by version_no desc limit 1;

  select jsonb_build_object(
    'profile_scores',p_profile_scores,
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

revoke execute on function public.publish_siddur(uuid,date,jsonb,text) from public,anon;
grant execute on function public.publish_siddur(uuid,date,jsonb,text) to authenticated;
