-- Contested waiting-list groups, part 7: publication settles the leftovers.
--
-- Two changes to publish_siddur(), reproduced verbatim from
-- 20260910090000_expire_proposals_on_day_publication.sql (the live definition):
--   1. it calls form_waitlist_groups() for every day being published, right after the
--      score validation and before the snapshot/notifications, so the Sadran can publish
--      instead of solving: trivial leftovers are auto-approved, contested ones become one
--      "בדיון" group each;
--   2. `unresolvedRequests` no longer blocks publication. publication_readiness() gains
--      `incompleteAssignments` (an assigned/merged request whose legs are not all covered
--      by a live ride with a driver) and `ready` now keys off that instead; the
--      `unresolvedRequests` count stays in the JSON for the UI to display.
--
-- REQ §7.3 / §13 (waiting list); DATA_MODEL.md §3.10, §6; ARCHITECTURE.md §7, §10.

-- publication_readiness(): reproduced verbatim from
-- 20260907104000_complete_day_readiness_and_legacy_reopen.sql with the split above.
create or replace function public.publication_readiness(p_department_id uuid,p_week_start date) returns jsonb
language plpgsql stable security definer set search_path=public,pg_temp as $$
declare result jsonb:='[]'; d date; requests_n int; unresolved_n int; incomplete_n int; pending_n int; missing_n int; conflicts_n int;
begin
  if not public.can_manage_week(p_department_id,p_week_start) then raise exception 'not_authorized';end if;
  for d in select p_week_start+i from generate_series(0,6) i loop
    select count(*),
      count(*) filter(where q.status in ('submitted','waitlisted','proposed')),
      count(*) filter(where q.status in ('assigned','merged') and not (
        (q.trip_shape='one_way_from' or exists(select 1 from public.ride_requests rr join public.rides r on r.id=rr.ride_id
          where rr.request_id=q.id and rr.covers_out and r.status<>'cancelled' and not r.needs_driver))
        and (q.trip_shape='one_way_to' or exists(select 1 from public.ride_requests rr join public.rides r on r.id=rr.ride_id
          where rr.request_id=q.id and rr.covers_return and r.status<>'cancelled' and not r.needs_driver))
      ))
    into requests_n,unresolved_n,incomplete_n from public.requests q where q.department_id=p_department_id and q.week_start=p_week_start
      and q.status not in ('draft','withdrawn','cancelled') and (coalesce(q.depart_at,q.return_at) at time zone 'Asia/Jerusalem')::date=d;
    select count(*) into pending_n from public.proposals p join public.requests q on q.id=p.request_id
      where p.department_id=p_department_id and p.week_start=p_week_start and p.status in ('draft','sent','accepted')
        and ((coalesce(q.depart_at,q.return_at) at time zone 'Asia/Jerusalem')::date=d
          or exists(select 1 from public.rides r where r.id=p.ride_id and (r.starts_at at time zone 'Asia/Jerusalem')::date=d));
    pending_n:=pending_n+(select count(*) from public.ride_change_requests c where c.department_id=p_department_id and c.week_start=p_week_start
      and c.status='pending' and (c.starts_at at time zone 'Asia/Jerusalem')::date=d);
    select count(*) into missing_n from public.rides r where r.department_id=p_department_id and r.week_start=p_week_start
      and r.status<>'cancelled' and r.needs_driver and (r.starts_at at time zone 'Asia/Jerusalem')::date=d;
    select count(distinct id) into conflicts_n from public.publication_conflicting_ride_ids(p_department_id,p_week_start,array[d]) id;
    result:=result||jsonb_build_array(jsonb_build_object('day',d,'published',public.is_day_public(p_department_id,p_week_start,d),
      'requestCount',requests_n,'unresolvedRequests',unresolved_n+incomplete_n,'incompleteAssignments',incomplete_n,
      'pendingProposals',pending_n,'missingDriverRides',missing_n,'conflictRides',conflicts_n,
      'ready',incomplete_n=0 and pending_n=0 and missing_n=0 and conflicts_n=0));
  end loop;
  return result;
end;
$$;

revoke execute on function public.publication_readiness(uuid,date) from public,anon;
grant execute on function public.publication_readiness(uuid,date) to authenticated;

create or replace function public.publish_siddur(p_department_id uuid, p_week_start date, p_profile_scores jsonb default '[]', p_expected_fingerprint text default null, p_policy_scores jsonb default '[]', p_days date[] default null, p_allow_unanswered boolean default false) returns uuid
security definer set search_path = public, pg_temp
language plpgsql as $$
declare
  v_snapshot jsonb;
  v_days date[]; v_prior_days date[]; v_public_days date[]; readiness jsonb;
  v_day date;
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
  lock table public.requests,public.rides,public.ride_requests,public.policies,public.department_settings,public.cars,public.car_seat_configs,public.car_maintenance_blocks,public.destinations,public.proposals,public.proposal_parties,public.ride_change_requests,public.ride_change_parties in share mode;
  if p_expected_fingerprint is not null and p_expected_fingerprint<>public.publish_scores_fingerprint(p_department_id,p_week_start) then
    raise exception 'stale_input' using errcode='P0409';
  end if;
  select array_agg(distinct d order by d) into v_days from unnest(coalesce(p_days,array(select p_week_start+i from generate_series(0,6) i))) d;
  if coalesce(cardinality(v_days),0)=0 or exists(select 1 from unnest(v_days) d where d is null or d<p_week_start or d>p_week_start+6) then
    raise exception 'invalid_publication_days';
  end if;
  select published_days into v_prior_days from public.weeks where department_id=p_department_id and week_start=p_week_start;
  select array_agg(distinct d order by d) into v_public_days from unnest(v_prior_days||v_days) d;
  if exists(select 1 from public.publication_conflicting_ride_ids(p_department_id,p_week_start,v_days)) then raise exception 'publication_conflicts';end if;
  readiness:=public.publication_readiness(p_department_id,p_week_start);
  -- 20260910091800: `unresolvedRequests` is informational now. A still-unresolved
  -- round-trip request no longer blocks publication — form_waitlist_groups() below either
  -- auto-approves it onto a free car or puts it into a contested group (REQ §7.3,
  -- consistency decision 25). What still blocks is a *defective* board: a request that IS
  -- assigned/merged but whose legs are not fully covered (`incompleteAssignments`), a
  -- pending proposal/ride change, or a ride with no driver.
  if not coalesce(p_allow_unanswered,false) and exists(select 1 from jsonb_array_elements(readiness) item
    where (item->>'day')::date=any(v_days) and ((item->>'incompleteAssignments')::int>0 or (item->>'pendingProposals')::int>0 or (item->>'missingDriverRides')::int>0))
  then raise exception 'publication_unanswered';end if;
  if jsonb_typeof(p_profile_scores) is distinct from 'array' or jsonb_typeof(p_policy_scores) is distinct from 'array' then
    raise exception 'invalid_publication_scores';
  end if;
  if p_expected_fingerprint is null then
    raise exception 'stale_input' using errcode='P0409';
  end if;
  -- A missing or unavailable score calculation must never prevent publication — scores are
  -- a reporting snapshot and can be recomputed later. But score data that IS supplied must
  -- still be complete (one entry per scoreable request, no orphan entries) and internally
  -- consistent (per-policy sums match); wrong/partial data would otherwise corrupt the
  -- fairness history permanently.
  if jsonb_array_length(p_profile_scores) > 0 then
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
  end if;
  if jsonb_array_length(p_policy_scores) > 0 then
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
  end if;
  -- 20260910091800 (contested waiting-list groups, REQ §7.3): before the snapshot is taken
  -- and before anybody is notified, settle each published day's leftovers — every trivially
  -- satisfiable round-trip request is auto-approved onto a free shared car, and each set of
  -- mutually overlapping requests that cannot all be served becomes one waitlist_groups row
  -- whose members are all told at once. Deliberately placed after the score validation
  -- above (which is checked against the pre-publish board) and before the snapshot below
  -- (so `rides`/`requests` in the siddur version, and the `published` notifications, carry
  -- the final outcome). Idempotent, so re-publishing a day is safe.
  foreach v_day in array v_days loop
    perform public.form_waitlist_groups(p_department_id, p_week_start, v_day);
  end loop;

  select * into v_prev from public.siddur_versions
  where department_id = p_department_id and week_start = p_week_start order by version_no desc limit 1;

  select jsonb_build_object(
    'selected_days',to_jsonb(v_days),
    'published_days',to_jsonb(v_public_days),
    'unanswered_acknowledged',coalesce(p_allow_unanswered,false),
    'scores_scope','whole_board',
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
    select id, requester_id, status, (coalesce(depart_at,return_at) at time zone 'Asia/Jerusalem')::date as request_day from public.requests
    where department_id = p_department_id and week_start = p_week_start and status not in ('draft','withdrawn','cancelled')
      and (coalesce(depart_at,return_at) at time zone 'Asia/Jerusalem')::date=any(v_days)
  loop
    v_prev_status := null;
    if v_prev is not null then
      select elem ->> 'status' into v_prev_status
      from jsonb_array_elements(v_prev.snapshot -> 'requests') elem
      where (elem ->> 'id')::uuid = v_req.id;
    end if;

    if v_prev is null or not (v_req.request_day=any(v_prior_days)) then
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

  update public.weeks set published_version_id = v_version_id, published_at = now(), phase = v_phase, published_days=v_public_days,
    open_at=least(open_at,now()-interval '1 second'),close_at=now(),publish_at=greatest(publish_at,now())
  where department_id = p_department_id and week_start = p_week_start;

  update public.rides set status = 'confirmed'
  where department_id = p_department_id and week_start = p_week_start and status = 'draft'
    and (starts_at at time zone 'Asia/Jerusalem')::date=any(v_days);

  perform set_config('app.in_publish', 'off', true);

  -- New (this migration): the day(s) just published are now public per is_day_public(), so
  -- any `sent` proposal still pending for one of them is settled face-to-face — expire it
  -- now instead of leaving it for the next app.tick().
  perform public.expire_proposals();

  return v_version_id;
end;
$$;

revoke execute on function public.publish_siddur(uuid,date,jsonb,text,jsonb,date[],boolean) from public,anon;
grant execute on function public.publish_siddur(uuid,date,jsonb,text,jsonb,date[],boolean) to authenticated;
