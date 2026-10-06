-- REQ §13.105 e (QA run 5): R5U3 publish readiness counts external/denied as answered and accepted
-- external/deny proposals as not pending; R5U4 the "published" notice lists one line per ride
-- (pickups included, external legs excluded) under a title that names whose days they are.

-- R5U4 (REQ §13.105 e): one line of the "published" notice for a ride the request is on:
-- "<weekday d.m> HH:MM–HH:MM · <route>", a pickup read as "איסוף מ<place>" (text_fragments publish.pickup).
insert into public.text_fragments (key, body) values
  ('publish.pickup', 'איסוף מ{{place}}'),
  ('publish.ride_line', '{{day}} {{range}} · {{what}}')
on conflict (key) do update set body = excluded.body, updated_at = now();

create or replace function public._publish_ride_line(p_request_id uuid, p_ride_id uuid)
returns text
language plpgsql stable security definer
set search_path = public, pg_temp
as $$
declare
  q public.requests%rowtype; r public.rides%rowtype; rr public.ride_requests%rowtype;
  v_what text; v_range text; v_pickup boolean; v_car text; v_origin text;
begin
  select * into q from public.requests where id = p_request_id;
  select * into r from public.rides where id = p_ride_id;
  select * into rr from public.ride_requests where request_id = p_request_id and ride_id = p_ride_id;
  v_pickup := rr.role = 'passenger' and rr.car_mode = 'chauffeur' and (rr.leg = 'return'
    or (q.origin_id is not null and q.origin_id is distinct from r.origin_id and q.trip_type = 'drop_off'));
  select name into v_car from public.cars where id = r.car_id;
  if v_pickup then
    v_origin := coalesce((select d.name from public.destinations d where d.id = case when rr.leg = 'return' then q.destination_id else q.origin_id end),
      case when rr.leg = 'return' then q.destination_text else q.origin_text end, '');
    v_what := public._frag('publish.pickup', jsonb_build_object('place', coalesce(v_origin, '')));
    v_range := to_char(coalesce(case when rr.leg = 'return' then q.return_at else q.depart_at end, r.starts_at) at time zone 'Asia/Jerusalem', 'HH24:MI');
  else
    v_what := coalesce(public.request_route_label(p_request_id), '');
    v_range := to_char(r.starts_at at time zone 'Asia/Jerusalem', 'HH24:MI') || '–' || to_char(r.ends_at at time zone 'Asia/Jerusalem', 'HH24:MI');
  end if;
  return public._frag('publish.ride_line', jsonb_build_object('day', public.day_date_label(r.starts_at),
    'range', v_range, 'what', concat_ws(' · ', nullif(v_what, ''), nullif(v_car, ''))));
end $$;
alter function public._publish_ride_line(uuid, uuid) owner to postgres;
revoke all on function public._publish_ride_line(uuid, uuid) from public;
grant execute on function public._publish_ride_line(uuid, uuid) to service_role;

-- Title: say whose days the list shows, not that only those days were published.
update public.notification_templates
set title = case when title = default_title then 'הסידור פורסם · הנסיעות שלך: {{days}}' else title end,
    default_title = 'הסידור פורסם · הנסיעות שלך: {{days}}'
where event = 'published' and variant is null;

create or replace function "public"."publication_readiness"("p_department_id" "uuid", "p_week_start" "date") RETURNS "jsonb"
    LANGUAGE "plpgsql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
declare result jsonb:='[]'; d date; requests_n int; unresolved_n int; incomplete_n int; placed_n int; awaiting_n int; answered_n int; pending_n int; draft_n int; missing_n int; conflicts_n int;
begin
  if not public.can_manage_week(p_department_id,p_week_start) then raise exception 'not_authorized';end if;
  if exists(select 1 from public.weeks w where w.department_id=p_department_id and w.week_start=p_week_start and w.phase='upcoming') then raise exception 'week_not_open'; end if;
  for d in select p_week_start+i from generate_series(0,6) i loop
    -- REQ §13.104 (R4B11): "placed" = the request holds a live ride on every leg (driver or not) = the solver's "served".
    -- unresolvedRequests = requests NOT placed (so requestCount - unresolvedRequests = placedRequests = solver served);
    -- incompleteAssignments = assigned/merged requests with a leg no ride covers; awaitingDriverRequests = placed but a leg
    -- only on a ride that still needs a driver (blocks publication through missingDriverRides, not as unresolved).
    select count(*),
      count(*) filter(where not public.request_legs_placed(q.id) and q.status not in ('external','denied')),
      count(*) filter(where q.status in ('assigned','merged') and not public.request_legs_placed(q.id)),
      count(*) filter(where public.request_legs_placed(q.id)),
      count(*) filter(where public.request_legs_placed(q.id) and public.request_awaits_driver(q.id)),
      count(*) filter(where q.status in ('external','denied'))
    into requests_n,unresolved_n,incomplete_n,placed_n,awaiting_n,answered_n from public.requests q where q.department_id=p_department_id and q.week_start=p_week_start
      and q.status not in ('draft','withdrawn','cancelled') and (coalesce(q.depart_at,q.return_at) at time zone 'Asia/Jerusalem')::date=d;
    -- 20261011400000 (REQ §13.105 e, R5U3): external/denied requests are answered (not 'unresolved'; counted in answeredRequests)
    -- and an accepted external/deny proposal is no longer 'pending'.
    -- 20261005110300: unsent drafts are counted separately (draftProposals) and no longer in
    -- pendingProposals, so a day with a draft is not blocked twice with two messages.
    select count(*) filter(where p.status='sent' or (p.status='accepted' and p.type not in ('external','deny'))), count(*) filter(where p.status='draft') into pending_n,draft_n
      from public.proposals p join public.requests q on q.id=p.request_id
      where p.department_id=p_department_id and p.week_start=p_week_start and p.status in ('draft','sent','accepted')
        and ((coalesce(q.depart_at,q.return_at) at time zone 'Asia/Jerusalem')::date=d
          or exists(select 1 from public.rides r where r.id=p.ride_id and (r.starts_at at time zone 'Asia/Jerusalem')::date=d));
    pending_n:=pending_n+(select count(*) from public.ride_change_requests c where c.department_id=p_department_id and c.week_start=p_week_start
      and c.status='pending' and (c.starts_at at time zone 'Asia/Jerusalem')::date=d);
    select count(*) into missing_n from public.rides r where r.department_id=p_department_id and r.week_start=p_week_start
      and r.status<>'cancelled' and r.needs_driver and (r.starts_at at time zone 'Asia/Jerusalem')::date=d;
    select count(distinct id) into conflicts_n from public.publication_conflicting_ride_ids(p_department_id,p_week_start,array[d]) id;
    result:=result||jsonb_build_array(jsonb_build_object('day',d,'published',public.is_day_public(p_department_id,p_week_start,d),
      'requestCount',requests_n,'unresolvedRequests',unresolved_n,'placedRequests',placed_n,'answeredRequests',answered_n,'awaitingDriverRequests',awaiting_n,'incompleteAssignments',incomplete_n,
      'pendingProposals',pending_n,'draftProposals',draft_n,'missingDriverRides',missing_n,'conflictRides',conflicts_n,
      'ready',incomplete_n=0 and pending_n=0 and draft_n=0 and missing_n=0 and conflicts_n=0));
  end loop;
  return result;
end;
$$;


create or replace function "public"."publish_siddur"("p_department_id" "uuid", "p_week_start" "date", "p_profile_scores" "jsonb" DEFAULT '[]'::"jsonb", "p_expected_fingerprint" "text" DEFAULT NULL::"text", "p_policy_scores" "jsonb" DEFAULT '[]'::"jsonb", "p_days" "date"[] DEFAULT NULL::"date"[], "p_allow_unanswered" boolean DEFAULT false) RETURNS "uuid"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
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
  if exists(select 1 from public.weeks where department_id=p_department_id and week_start=p_week_start and phase='upcoming') then raise exception 'week_not_open'; end if;
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
  -- 20261005110300 (REQ §13.94): unsent draft proposals on a selected day always block, and
  -- `p_allow_unanswered` does not bypass it — a draft is the Sadran's own unfinished work.
  if exists(select 1 from jsonb_array_elements(readiness) item
    where (item->>'day')::date=any(v_days) and (item->>'draftProposals')::int>0)
  then raise exception 'publication_drafts';end if;
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
  -- 20260910096000 (owner decision, REQ §9): one notification per recipient per publish
  -- call, not one per request. Group every non-cancelled request in scope by requester,
  -- split into a `published` set (day newly public) and an `outcome_changed` set (status
  -- changed since the previous version, on an already-public day), and enqueue at most one
  -- notification of each kind per recipient, listing every affected day/request. The
  -- explicit `days`/`outcomeLine`/`diffLine` vars below win over the single-request
  -- defaults notification_context() would otherwise compute from `data.request_id`
  -- (enqueue_notification does `notification_context(...) || _vars`, right side wins).
  for v_req in
    with scoped as (
      select q.id, q.requester_id, q.status,
        (coalesce(q.depart_at,q.return_at) at time zone 'Asia/Jerusalem')::date as request_day,
        (coalesce(q.depart_at,q.return_at) at time zone 'Asia/Jerusalem')::date = any(v_prior_days) as day_was_public,
        (select elem ->> 'status' from jsonb_array_elements(coalesce(v_prev.snapshot -> 'requests','[]'::jsonb)) elem
          where (elem ->> 'id')::uuid = q.id) as prev_status,
        coalesce(rd.starts_at,q.depart_at,q.return_at) as line_dt,
        coalesce(rd.starts_at,q.depart_at) as line_depart,
        coalesce(rd.ends_at,q.return_at) as line_return,
        coalesce(c.name,dest.name,q.destination_text,'') as line_place
      from public.requests q
      left join lateral (
        select rr.ride_id from public.ride_requests rr join public.rides x on x.id = rr.ride_id
        where rr.request_id = q.id and x.status <> 'cancelled' limit 1
      ) rl on true
      left join public.rides rd on rd.id = rl.ride_id
      left join public.cars c on c.id = rd.car_id
      left join public.destinations dest on dest.id = q.destination_id
      where q.department_id = p_department_id and q.week_start = p_week_start and q.status not in ('draft','withdrawn','cancelled','external')
        and (coalesce(q.depart_at,q.return_at) at time zone 'Asia/Jerusalem')::date = any(v_days)
    ), ride_chg as (
      -- REQ §13.102 R2Q3 / COPY_DRAFT §7: one line per changed ride, old -> new against the previous published
      -- snapshot (rides by id). A ride with no earlier snapshot (or a status change) reads as the new placement.
      select s.id as request_id, s.requester_id, s.request_day, x.id as ride_id,
        public.day_date_label(coalesce(x.starts_at, s.line_dt)) as line_day,
        public.request_route_label(s.id) as route,
        case
          when x.id is null then case when s.prev_status is distinct from s.status::text
                                      then public._frag('publish.removed') else '' end
          when pv.elem is null or s.prev_status is distinct from s.status::text then
            public._frag('publish.new_ride', jsonb_build_object('car', coalesce((select cc.name from public.cars cc where cc.id = x.car_id), ''),
              'depart', public._hhmm(x.starts_at), 'return', public._hhmm(x.ends_at)))
          else concat_ws(' · ',
            nullif(public._time_change_line((pv.elem ->> 'starts_at')::timestamptz, (pv.elem ->> 'ends_at')::timestamptz, x.starts_at, x.ends_at), ''),
            case when (pv.elem ->> 'car_id')::uuid is distinct from x.car_id then
              public._frag('change.car', jsonb_build_object('newCar', coalesce((select cc.name from public.cars cc where cc.id = x.car_id), ''),
                'oldCar', coalesce((select cc.name from public.cars cc where cc.id = (pv.elem ->> 'car_id')::uuid), ''))) end,
            case when (pv.elem ->> 'driver_id')::uuid is distinct from x.driver_id and x.driver_id is not null then
              public._frag('change.driver', jsonb_build_object('driverName', coalesce((select pf.full_name from public.profiles pf where pf.id = x.driver_id), ''))) end)
        end as line_change
      from scoped s
      left join lateral (
        select r2.* from public.ride_requests rr join public.rides r2 on r2.id = rr.ride_id
        where rr.request_id = s.id and r2.status <> 'cancelled'
      ) x on true
      left join lateral (
        select elem from jsonb_array_elements(coalesce(v_prev.snapshot -> 'rides','[]'::jsonb)) elem
        where (elem ->> 'id')::uuid = x.id limit 1
      ) pv on true
      where v_prev is not null and s.day_was_public
    ), classified as (
      select s.*,
        case when v_prev is null or not day_was_public then 'published'
          when prev_status is distinct from status::text
            or exists (select 1 from ride_chg rc where rc.request_id = s.id and rc.line_change <> '') then 'outcome_changed'
          else null end as event_kind,
        concat_ws(' · ',
          public.day_date_label(line_dt) || ' ' ||
            to_char(line_depart at time zone 'Asia/Jerusalem','HH24:MI') || '–' ||
            to_char(line_return at time zone 'Asia/Jerusalem','HH24:MI'),
          nullif(line_place,'')
        ) as request_line
      from scoped s
    ), pub_ride_lines as (
      -- R5U4: one line per ride the member is on (a pickup is its own ride and its own line); a request with
      -- no live ride keeps its single requested-time line. Rides outside the published days are not listed.
      select c.requester_id, c.id as request_id, c.request_day, x.starts_at as line_start,
        public._publish_ride_line(c.id, x.id) as line
      from classified c
      join public.ride_requests rr on rr.request_id = c.id
      join public.rides x on x.id = rr.ride_id and x.status <> 'cancelled'
      where c.event_kind = 'published'
        and (x.starts_at at time zone 'Asia/Jerusalem')::date = any(v_days)
      union all
      select c.requester_id, c.id, c.request_day, coalesce(c.line_depart, c.line_dt), c.request_line
      from classified c
      where c.event_kind = 'published'
        and not exists (select 1 from public.ride_requests rr join public.rides x on x.id = rr.ride_id
                        where rr.request_id = c.id and x.status <> 'cancelled')
    ), days_agg as (
      select requester_id, event_kind, string_agg(public.day_date_label(request_day), ', ' order by request_day) as days_list
      from (select distinct requester_id, event_kind, request_day from classified where event_kind is not null) d
      group by requester_id, event_kind
    ), chg_lines as (
      select rc.requester_id, rc.request_id, rc.request_day,
        public._frag('publish.line', jsonb_build_object('route', rc.route, 'day', rc.line_day, 'changeLine', rc.line_change)) as line,
        row_number() over (partition by rc.requester_id order by rc.request_day, rc.request_id, rc.ride_id) as rn,
        count(*) over (partition by rc.requester_id) as tot
      from ride_chg rc join classified cl on cl.id = rc.request_id and cl.event_kind = 'outcome_changed'
      where rc.line_change <> ''
    ), lines_agg as (
      select requester_id, 'published'::text as event_kind,
        string_agg(line, chr(10) order by line_start, request_id) as lines,
        (array_agg(request_id order by line_start, request_id))[1] as first_id
      from pub_ride_lines
      group by requester_id
      union all
      select cl.requester_id, 'outcome_changed',
        string_agg(cl.line, chr(10) order by cl.rn) filter (where cl.rn <= 3)
          || case when max(cl.tot) > 3 then chr(10) || public._frag('publish.more', jsonb_build_object('count', (max(cl.tot) - 3)::text)) else '' end,
        (array_agg(cl.request_id order by cl.rn))[1]
      from chg_lines cl group by cl.requester_id
    )
    select l.requester_id, l.event_kind, d.days_list, l.lines, l.first_id
    from lines_agg l join days_agg d using (requester_id, event_kind)
  loop
    v_event := v_req.event_kind::public.notification_event;
    perform public.enqueue_notification(v_req.requester_id, v_event, p_department_id, p_week_start,
      case when v_event = 'published' then jsonb_build_object('days', v_req.days_list, 'outcomeLine', v_req.lines)
        else jsonb_build_object('days', v_req.days_list, 'diffLine', v_req.lines) end,
      jsonb_build_object('request_id', v_req.first_id), format('%s:%s:%s', v_event, v_version_id, v_req.requester_id));
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

