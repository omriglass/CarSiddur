-- A sent proposal no longer expires on a timer: it expires only once its own day has
-- been published (weeks.published_days, `is_day_public()`) or has passed in Asia/Jerusalem.
-- Rationale: the Sadran may be late publishing and needs proposals open until then; once a
-- day's siddur is published, everything on that day is assumed settled face-to-face, so any
-- proposal still pending for it is expired right away instead of lingering.
-- `department_settings.proposal_expiry_mode` / `proposal_expiry_hours` are obsolete (kept,
-- not dropped, to avoid a types regen outside this change) — no function reads them any more.
-- REQ §13.29; DATA_MODEL §3.1, §3.8, §5 invariant #6.

-- expires_at is no longer a deadline; create_proposal() stops computing one.
alter table public.proposals alter column expires_at drop not null;

-- Dead weight: nothing filters `sent` proposals by expires_at any more.
drop index if exists public.proposals_expiring_idx;

-- create_proposal() has several later patches applied in place via pg_get_functiondef()
-- (20260907095300_guard_merge_authority_and_driver_schedule.sql prepends a p_created_via
-- check; 20260907105000_allow_same_day_proposal_end.sql widens the merge end-time guard to
-- accept 23:59). A full CREATE OR REPLACE here would silently drop both. Patch the live
-- definition instead, touching only the expiry computation.
do $migration$
declare def text;
  old_settings text := '  select * into v_settings from public.department_settings where department_id = v_req.department_id;
  v_expires_at := case when v_settings.proposal_expiry_mode = ''fixed_hours''
    then now() + make_interval(hours => v_settings.proposal_expiry_hours)
    else (select w.publish_at from public.weeks w where w.department_id = v_req.department_id and w.week_start = v_req.week_start)
    end;

  v_token := public.generate_token();';
  new_settings text := '  -- No timer any more: expires_at stays null until the proposal''s day is
  -- published or has passed (expire_proposals(), 20260910090000, decides that).
  v_token := public.generate_token();';
  old_decl text := '  v_expires_at timestamptz;
  v_settings record;
';
  old_insert text := '    v_req.status, encode(digest(v_token, ''sha256''), ''hex''), v_expires_at, (select auth.uid()), p_created_via)';
  new_insert text := '    v_req.status, encode(digest(v_token, ''sha256''), ''hex''), null, (select auth.uid()), p_created_via)';
begin
  def := pg_get_functiondef('public.create_proposal(uuid,uuid,public.proposal_type,jsonb,text,uuid[],text)'::regprocedure);
  if strpos(def, old_settings) = 0 then raise exception 'unexpected_create_proposal_expiry_block'; end if;
  def := replace(def, old_settings, new_settings);
  if strpos(def, old_decl) = 0 then raise exception 'unexpected_create_proposal_declarations'; end if;
  def := replace(def, old_decl, '');
  if strpos(def, old_insert) = 0 then raise exception 'unexpected_create_proposal_insert'; end if;
  def := replace(def, old_insert, new_insert);
  execute def;
end;
$migration$;

-- Redefined: a `sent` proposal expires once its own day (derived from the request's
-- depart_at/return_at, same convention as publish_siddur/publication_readiness) is public
-- (`is_day_public()`, 20260907101000_publish_selected_days.sql) or has already ended in
-- Asia/Jerusalem (its calendar day is before "today" there) — never a fixed deadline.
-- `answer_proposal()`'s `now() > expires_at` guard is untouched: with expires_at now
-- typically null, that comparison is null, and `if null then …` does not raise — a proposal
-- can still be answered right up until this function (or the publish that triggers it) flips
-- it to `expired`. Still called from app.tick() -> expire_proposals() (cron.sql) every 15
-- minutes for the "day passed" case, and now also from publish_siddur() itself so a
-- publish expires that day's proposals immediately instead of waiting for the next tick.
create or replace function public.expire_proposals(_now timestamptz default now()) returns int
security definer set search_path = public, pg_temp
language plpgsql as $$
declare v_count int := 0; request_row record; r record; v_today date;
begin
  v_today := (_now at time zone 'Asia/Jerusalem')::date;
  for request_row in
    select q.id, q.department_id, q.week_start,
      (coalesce(q.depart_at, q.return_at) at time zone 'Asia/Jerusalem')::date as req_day
    from public.requests q
    where exists(select 1 from public.proposals p where p.request_id = q.id and p.status = 'sent')
    order by q.id for update skip locked
  loop
    if request_row.req_day < v_today
      or public.is_day_public(request_row.department_id, request_row.week_start, request_row.req_day)
    then
      for r in
        update public.proposals set status = 'expired'
        where request_id = request_row.id and status = 'sent'
        returning id, department_id, week_start, request_id, previous_status, created_by
      loop
        v_count := v_count + 1;
        perform public.enqueue_notification(r.created_by, 'proposal_answered', r.department_id, r.week_start,
          '{}'::jsonb, jsonb_build_object('variant', 'expired', 'request_id', r.request_id),
          format('proposal_expired:%s', r.id));
      end loop;
    end if;
  end loop;
  return v_count;
end $$;

-- publish_siddur(): call expire_proposals() at the end, after weeks.published_days/phase are
-- updated, so members don't wait for the next 15-minute tick to see today's siddur settle
-- pending proposals for the day(s) just published. Reproduced verbatim from
-- 20260909097000_restrict_empty_publication_scores.sql (the live definition) with only that
-- one addition.
create or replace function public.publish_siddur(p_department_id uuid, p_week_start date, p_profile_scores jsonb default '[]', p_expected_fingerprint text default null, p_policy_scores jsonb default '[]', p_days date[] default null, p_allow_unanswered boolean default false) returns uuid
security definer set search_path = public, pg_temp
language plpgsql as $$
declare
  v_snapshot jsonb;
  v_days date[]; v_prior_days date[]; v_public_days date[]; readiness jsonb;
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
  if not coalesce(p_allow_unanswered,false) and exists(select 1 from jsonb_array_elements(readiness) item
    where (item->>'day')::date=any(v_days) and ((item->>'unresolvedRequests')::int>0 or (item->>'pendingProposals')::int>0 or (item->>'missingDriverRides')::int>0))
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
