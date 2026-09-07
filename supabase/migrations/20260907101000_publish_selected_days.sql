-- Incremental day publication; private planning survives publishing/reopening.
alter table public.weeks add column published_days date[] not null default '{}';
update public.weeks w set published_days = array(select w.week_start + d from generate_series(0,6) d)
where w.phase in ('published','live','archived');

create function public.is_day_public(p_department_id uuid,p_week_start date,p_day date) returns boolean
language sql stable security definer set search_path=public,pg_temp as $$
  select exists(select 1 from public.weeks w where w.department_id=p_department_id and w.week_start=p_week_start
    and w.phase in ('published','live','archived') and p_day=any(w.published_days));
$$;
revoke execute on function public.is_day_public(uuid,date,date) from public,anon;
grant execute on function public.is_day_public(uuid,date,date) to authenticated;

create or replace function public.request_served_by_public_ride(_request_id uuid) returns boolean
language sql stable security definer set search_path=public,pg_temp as $$
  select exists(select 1 from public.ride_requests rr join public.rides r on r.id=rr.ride_id
    where rr.request_id=_request_id and r.status not in ('draft','cancelled')
      and public.is_day_public(r.department_id,r.week_start,(r.starts_at at time zone 'Asia/Jerusalem')::date));
$$;
drop policy rides_select on public.rides;
create policy rides_select on public.rides for select to authenticated using (
  public.can_manage_week(department_id,week_start)
  or (public.is_approved() and status not in ('draft','cancelled')
    and public.is_day_public(department_id,week_start,(starts_at at time zone 'Asia/Jerusalem')::date))
);
drop policy ride_requests_select on public.ride_requests;
create policy ride_requests_select on public.ride_requests for select to authenticated
using(exists(select 1 from public.rides r where r.id=ride_id));
-- Historical snapshots contain private days and policy comparisons. Member screens
-- read the RLS-filtered current views, never the coordinator's full snapshots.
drop policy siddur_versions_select on public.siddur_versions;
create policy siddur_versions_select on public.siddur_versions for select to authenticated
using(public.can_manage_week(department_id,week_start));
drop policy request_companions_published_select on public.request_companions;
create policy request_companions_published_select on public.request_companions for select to authenticated
using(exists(select 1 from public.requests q where q.id=request_id and public.member_of(q.department_id)
  and public.request_served_by_public_ride(q.id)));

-- Only selected-day defects block publication. Adjacent coordinator-approved
-- slots are valid; physical overlaps, wrong locations/dates and unsafe loads are not.
create function public.publication_conflicting_ride_ids(p_department_id uuid,p_week_start date,p_days date[]) returns setof uuid
language plpgsql stable security definer set search_path=public,pg_temp as $$
declare r record; home uuid; bad boolean;
begin
  select home_destination_id into home from public.departments where id=p_department_id;
  for r in
    select * from public.rides where department_id=p_department_id and week_start=p_week_start and status<>'cancelled'
      and (starts_at at time zone 'Asia/Jerusalem')::date=any(p_days)
  loop
    bad:=r.starts_at>=r.ends_at or (r.starts_at at time zone 'Asia/Jerusalem')::date<>(r.ends_at at time zone 'Asia/Jerusalem')::date
      or (r.ends_at at time zone 'Asia/Jerusalem')::time>'23:59'::time
      or (r.starts_at at time zone 'Asia/Jerusalem')::date not between p_week_start and p_week_start+6;
    bad:=bad or exists(select 1 from public.rides other where other.id<>r.id and other.status<>'cancelled'
      and (other.car_id=r.car_id or (r.driver_id is not null and other.driver_id=r.driver_id))
      and tstzrange(other.starts_at,other.ends_at,'[)') && tstzrange(r.starts_at,r.ends_at,'[)'));
    bad:=bad or exists(select 1 from public.car_maintenance_blocks b where b.car_id=r.car_id
      and tstzrange(b.starts_at,b.ends_at,'[)') && tstzrange(r.starts_at,r.ends_at,'[)'));
    bad:=bad or not exists(select 1 from public.cars c where c.id=r.car_id and c.department_id=p_department_id and c.status='active');
    bad:=bad or r.origin_id is distinct from coalesce((select prev.destination_id from public.rides prev
      where prev.car_id=r.car_id and prev.week_start=p_week_start and prev.status<>'cancelled' and (prev.starts_at,prev.id)<(r.starts_at,r.id)
      order by prev.starts_at desc,prev.id desc limit 1),home);
    bad:=bad or exists(select 1 from public.rides following where following.id=(select nxt.id from public.rides nxt
      where nxt.car_id=r.car_id and nxt.week_start=p_week_start and nxt.status<>'cancelled' and (nxt.starts_at,nxt.id)>(r.starts_at,r.id)
      order by nxt.starts_at,nxt.id limit 1) and following.origin_id is distinct from r.destination_id);
    bad:=bad or (r.destination_id is distinct from home and r.overnight_ack_by is null and not exists(
      select 1 from public.rides later where later.car_id=r.car_id and later.status<>'cancelled'
        and later.starts_at>r.starts_at and (later.starts_at at time zone 'Asia/Jerusalem')::date=(r.starts_at at time zone 'Asia/Jerusalem')::date));
    begin
      perform public.assert_ride_request_day(r.id);
      perform public.assert_ride_driver(r.id);
      perform public.assert_ride_seats_fit(r.id);
    exception when raise_exception or check_violation then bad:=true;
    end;
    if bad then return next r.id;end if;
  end loop;
  -- 1020 adds private provisional shadows. JSON access keeps this migration
  -- applicable first, while making pending provisional edits a hard blocker.
  return query select distinct c.ride_id from public.ride_change_requests c
    where c.department_id=p_department_id and c.week_start=p_week_start and c.status='pending'
      and coalesce((to_jsonb(c)->>'is_planning')::boolean,false)
      and (c.starts_at at time zone 'Asia/Jerusalem')::date=any(p_days);
end;
$$;
revoke execute on function public.publication_conflicting_ride_ids(uuid,date,date[]) from public,anon,authenticated;

create function public.publication_readiness(p_department_id uuid,p_week_start date) returns jsonb
language plpgsql stable security definer set search_path=public,pg_temp as $$
declare result jsonb:='[]'; d date; requests_n int; unresolved_n int; pending_n int; missing_n int; conflicts_n int;
begin
  if not public.can_manage_week(p_department_id,p_week_start) then raise exception 'not_authorized';end if;
  for d in select p_week_start+i from generate_series(0,6) i loop
    select count(*),count(*) filter(where q.status in ('submitted','waitlisted','proposed')
      or (q.status in ('assigned','merged') and not exists(select 1 from public.ride_requests rr join public.rides r on r.id=rr.ride_id
        where rr.request_id=q.id and r.status<>'cancelled' and not r.needs_driver)))
    into requests_n,unresolved_n from public.requests q where q.department_id=p_department_id and q.week_start=p_week_start
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
      'requestCount',requests_n,'unresolvedRequests',unresolved_n,'pendingProposals',pending_n,'missingDriverRides',missing_n,'conflictRides',conflicts_n,
      'ready',unresolved_n=0 and pending_n=0 and missing_n=0 and conflicts_n=0));
  end loop;
  return result;
end;
$$;
revoke execute on function public.publication_readiness(uuid,date) from public,anon;
grant execute on function public.publication_readiness(uuid,date) to authenticated;

-- Proposal/consent changes are publication inputs too; do not acknowledge a
-- different set of unanswered items than the coordinator reviewed.
create or replace function public.publish_scores_fingerprint(p_department_id uuid,p_week_start date) returns text
security definer stable set search_path = public, pg_temp language plpgsql as $$
begin
  if not public.can_manage_week(p_department_id,p_week_start) then raise exception 'not_authorized'; end if;
  return md5(jsonb_build_object(
    'proposals',(select jsonb_agg(to_jsonb(p) order by id) from public.proposals p where department_id=p_department_id and week_start=p_week_start),
    'proposal_parties',(select jsonb_agg(to_jsonb(pp) order by pp.proposal_id,pp.profile_id) from public.proposal_parties pp join public.proposals p on p.id=pp.proposal_id where p.department_id=p_department_id and p.week_start=p_week_start),
    'ride_changes',(select jsonb_agg(to_jsonb(c) order by id) from public.ride_change_requests c where department_id=p_department_id and week_start=p_week_start),
    'ride_change_parties',(select jsonb_agg(to_jsonb(cp) order by cp.id) from public.ride_change_parties cp join public.ride_change_requests c on c.id=cp.change_id where c.department_id=p_department_id and c.week_start=p_week_start),
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

drop function public.publish_siddur(uuid,date,jsonb,text,jsonb);
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

  return v_version_id;
end;
$$;

revoke execute on function public.publish_siddur(uuid,date,jsonb,text,jsonb,date[],boolean) from public,anon;
grant execute on function public.publish_siddur(uuid,date,jsonb,text,jsonb,date[],boolean) to authenticated;

create function public.reopen_week(p_department_id uuid,p_week_start date,p_phase public.week_phase,p_expected_fingerprint text) returns void
language plpgsql security definer set search_path=public,pg_temp as $$
declare w public.weeks%rowtype; deadline timestamptz;
begin
  if not public.is_approved() or not public.can_manage_week(p_department_id,p_week_start) then raise exception 'not_authorized';end if;
  if p_phase not in ('open','solving') or p_phase is null then raise exception 'not_authorized';end if;
  select * into w from public.weeks where department_id=p_department_id and week_start=p_week_start for update;
  if not found then raise exception 'week_not_open';end if;
  if w.phase='archived' or now()>=upper(public.week_range(p_week_start)) then raise exception 'week_archived';end if;
  lock table public.requests,public.rides,public.ride_requests,public.proposals,public.proposal_parties,public.ride_change_requests,public.ride_change_parties in share mode;
  if p_expected_fingerprint is null or p_expected_fingerprint<>public.publish_scores_fingerprint(p_department_id,p_week_start) then
    raise exception 'stale_input' using errcode='P0409';
  end if;
  deadline:=case when p_phase='open' then greatest(w.close_at,upper(public.week_range(p_week_start))) else now() end;
  perform set_config('app.audit_reason','reopen_week',true);
  perform set_config('app.in_publish','on',true);
  update public.weeks set phase=p_phase,published_days='{}',published_version_id=null,published_at=null,
    open_at=least(open_at,now()-interval '1 second'),close_at=deadline,publish_at=greatest(publish_at,deadline)
    where department_id=p_department_id and week_start=p_week_start;
  -- Keep real ongoing/completed rides intact. Future assignments become private
  -- drafts with all IDs, windows, drivers, seats, pins and request links preserved.
  update public.rides set status='draft' where department_id=p_department_id and week_start=p_week_start
    and status in ('confirmed','flagged') and starts_at>now();
  perform set_config('app.in_publish','off',true);
end;
$$;
revoke execute on function public.reopen_week(uuid,date,public.week_phase,text) from public,anon;
grant execute on function public.reopen_week(uuid,date,public.week_phase,text) to authenticated;
