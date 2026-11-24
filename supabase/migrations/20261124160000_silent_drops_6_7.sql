-- Silent drops 6 and 7 (owner 2026-11-24, REQ item 267 g/h; wordings owner-approved 2026-11-24).
-- 6: the publish notice of a two-way request with only one way on a ride lists the waiting way too
--    ("ברשימת המתנה: איסוף מבנימינה ב־14:00"), and a ride line of a ride still without a driver ends "עוד אין נהג/ת".
-- 7: a route change of a host's request applied through a `shift` proposal (the server side of the removed ride-sheet
--    route editor) used to leave a merged guest whose pickup became the ride's final place off the route, still
--    "merged" and untold. The guest now goes back to waiting (HOST_EDITED, as a host's own edit does) and is told
--    (outcome_changed `host_route_off`, held until publish on an unpublished day). The request form already asked.

insert into public.text_fragments (key, body) values
  ('publish.no_driver', 'עוד אין נהג/ת'),
  ('publish.leg_drop_off', 'הקפצה ל{{place}} ב־{{time}}'),
  ('publish.leg_pickup', 'איסוף מ{{place}} ב־{{time}}'),
  ('publish.leg_out', 'הלוך ל{{place}} ב־{{time}}'),
  ('publish.leg_return', 'חזור מ{{place}} ב־{{time}}')
on conflict (key) do nothing;

insert into public.notification_templates (event, channel, variant, title, body, default_title, default_body)
select 'outcome_changed'::public.notification_event, ch::public.notification_channel, 'host_route_off', t.title, t.body, t.title, t.body
from (values ('{{place}} לא במסלול', 'יום {{day}} · הנסיעה של {{driver}} כבר לא עוברת ב{{place}}. הבקשה שלך ממתינה לשיבוץ מחדש.')) as t(title, body)
cross join (values ('inbox'), ('push')) as c(ch)
on conflict (event, channel, coalesce(variant, '')) do nothing;

-- The waiting way of a two-way request, as the member asked it: "הקפצה ל<X> ב־08:00" / "איסוף מ<X> ב־14:00"
-- for a הקפצה, else "הלוך ל<X>" / "חזור מ<X>".
create or replace function public._publish_waiting_leg_line(p_request_id uuid, p_leg text)
returns text language sql stable security definer set search_path = public, pg_temp as $$
  select public._frag(
    case when q.trip_type = 'drop_off' then case when p_leg = 'out' then 'publish.leg_drop_off' else 'publish.leg_pickup' end
         else case when p_leg = 'out' then 'publish.leg_out' else 'publish.leg_return' end end,
    jsonb_build_object('place', coalesce(d.name, q.destination_text, ''),
      'time', to_char(case when p_leg = 'out' then q.depart_at else q.return_at end at time zone 'Asia/Jerusalem', 'HH24:MI')))
  from public.requests q left join public.destinations d on d.id = q.destination_id
  where q.id = p_request_id;
$$;
revoke all on function public._publish_waiting_leg_line(uuid, text) from public, anon, authenticated;

-- Merged guests of the rides this request leads whose pickup is now where a leg of the ride ends (REQ §13.95: no ride
-- at all - `_ride_route_with` leaves them off the route): taken off the ride like an unmerge, back to waiting
-- (`HOST_EDITED`), each told once (never the one who made the change). Returns how many.
create or replace function public._release_guests_off_route(p_request_id uuid)
returns int language plpgsql security definer set search_path = public, pg_temp as $$
declare
  g record; v_leg public.ride_leg; v_swap boolean; v_covers boolean; v_board uuid; v_last uuid; v_off uuid;
  v_n int := 0; v_actor uuid := (select auth.uid()); v_driver text; v_ride public.rides%rowtype;
begin
  for g in
    select r.id as ride_id, gq.id as guest_id, gq.requester_id, gq.origin_id, gq.destination_id,
           bool_or(gr.covers_out) as c_out, bool_or(gr.covers_return) as c_ret
    from public.rides r
    join public.ride_requests gr on gr.ride_id = r.id and gr.request_id <> p_request_id and gr.chain is null and gr.role = 'passenger'
    join public.requests gq on gq.id = gr.request_id
    where r.status <> 'cancelled'
      and (select b.request_id from public.ride_requests b where b.ride_id = r.id
           order by (b.role = 'driver') desc, b.created_at, b.request_id limit 1) = p_request_id
    group by r.id, gq.id, gq.requester_id, gq.origin_id, gq.destination_id
    order by r.id, gq.id
  loop
    v_off := null;
    v_swap := public._merge_guest_swapped(g.ride_id, g.guest_id);
    foreach v_leg in array array['out', 'return']::public.ride_leg[] loop
      v_covers := case when v_swap then (v_leg = 'return' and (g.c_out or g.c_ret))
                       when v_leg = 'out' then g.c_out else g.c_ret end;
      continue when not coalesce(v_covers, false);
      v_board := case when v_leg = 'out' or v_swap then g.origin_id else g.destination_id end;
      select x.place_id into v_last from public._ride_route(g.ride_id) x where x.leg = v_leg order by x."position" desc limit 1;
      if v_board is not null and v_board = v_last then v_off := v_board; exit; end if;
    end loop;
    continue when v_off is null;

    select * into v_ride from public.rides where id = g.ride_id;
    perform public._unmerge_core(g.ride_id, g.guest_id, 'HOST_EDITED');
    v_n := v_n + 1;
    if g.requester_id is distinct from v_actor then
      select coalesce(pd.full_name, pb.full_name) into v_driver
      from (select 1) one
      left join public.profiles pd on pd.id = v_ride.driver_id
      left join public.profiles pb on pb.id = (select q.requester_id from public.requests q where q.id = p_request_id);
      perform public.enqueue_notification(g.requester_id, 'outcome_changed', v_ride.department_id, v_ride.week_start,
        jsonb_build_object('day', public.day_date_label(v_ride.starts_at), 'driver', coalesce(v_driver, ''),
          'place', coalesce((select d.name from public.destinations d where d.id = v_off), '')),
        jsonb_build_object('variant', 'host_route_off', 'ride_id', g.ride_id, 'request_id', g.guest_id),
        format('host_route_off:%s:%s:%s', g.ride_id, g.guest_id, v_ride.version));
    end if;
  end loop;
  return v_n;
end $$;
revoke all on function public._release_guests_off_route(uuid) from public, anon, authenticated;

CREATE OR REPLACE FUNCTION "public"."_notice_is_unpublished_outcome"("_event" "public"."notification_event", "_data" "jsonb", "_recipient" "uuid", "_department_id" "uuid", "_week_start" "date", "_caller_days" "text") RETURNS boolean
    LANGUAGE "plpgsql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
declare
  v_variant text := nullif(_data ->> 'variant', '');
  v_ride_id uuid := nullif(_data ->> 'ride_id', '')::uuid;
  v_request_id uuid := nullif(_data ->> 'request_id', '')::uuid;
  v_at timestamptz;
begin
  if _event <> 'outcome_changed' or _department_id is null or _week_start is null then return false; end if;
  if v_variant is null then
    -- the publish-time diff carries its own `days`; any other null-variant outcome is a ride-level notice
    if _caller_days is not null or v_ride_id is null then return false; end if;
  elsif v_variant not in (
    'merged', 'merged_no_driver', 'merged_split', 'joined_ride', 'placed_by_sadran', 'driver_assigned',
    'driver_assigned_passenger', 'driver_cancelled', 'driver_cancelled_plain', 'driver_changed_passenger',
    'driver_replaced_you', 'driver_unassigned', 'car_changed', 'time_changed', 'edit_applied', 'edit_waitlisted',
    'alternative_applied', 'own_car_placed', 'passenger_added_you', 'passenger_joined', 'passenger_left', 'passenger_left_many',
    'passenger_removed_request', 'passenger_removed_you', 'companion_split', 'passengers_added', 'passengers_removed',
    'reservation_added', 'ride_cancelled', 'unassigned_by_sadran', 'child_removed', 'join_ride_cancelled', 'join_asked',
    'rider_place_off_route', 'host_route_off'
  ) then
    return false;
  end if;
  if _recipient is not null and exists (select 1 from public.sadranim_of(_department_id, _week_start) s where s = _recipient) then
    return false;
  end if;
  -- R14B5: a member who accepted an offer in the app is told what it did, published day or not: the answer was
  -- theirs, so the result is not planning news to hide. (The accepted party row is set before the proposal is applied.)
  if v_request_id is not null and _recipient is not null and exists (
       select 1 from public.proposals p join public.proposal_parties pp on pp.proposal_id = p.id
       where p.request_id = v_request_id and p.status = 'applied' and p.applied_at = now()
         and pp.profile_id = _recipient and pp.response = 'accepted' and pp.responded_via in ('token', 'session')) then
    return false;
  end if;
  if v_ride_id is not null then select r.starts_at into v_at from public.rides r where r.id = v_ride_id; end if;
  if v_at is null and v_request_id is not null then
    select coalesce(q.depart_at, q.return_at) into v_at from public.requests q where q.id = v_request_id;
  end if;
  if v_at is null then return false; end if;
  return not public.is_day_public(_department_id, _week_start, (v_at at time zone 'Asia/Jerusalem')::date);
end $$;

CREATE OR REPLACE FUNCTION "public"."_publish_ride_line_core"("p_request_id" "uuid", "p_ride_id" "uuid", "p_viewer" "uuid") RETURNS "text"
    LANGUAGE "plpgsql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
declare
  q public.requests%rowtype; r public.rides%rowtype; rr public.ride_requests%rowtype;
  v_what text; v_range text; v_pickup boolean; v_car text; v_origin text; v_span tstzrange;
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
    v_span := public.person_ride_span(p_ride_id, coalesce(p_viewer, q.requester_id));
    v_range := to_char(coalesce(lower(v_span), r.starts_at) at time zone 'Asia/Jerusalem', 'HH24:MI') || '–'
      || to_char(coalesce(upper(v_span), r.ends_at) at time zone 'Asia/Jerusalem', 'HH24:MI');
  end if;
  return public._frag('publish.ride_line', jsonb_build_object('day', public.day_date_label(r.starts_at),
    'range', v_range, 'what', concat_ws(' · ', nullif(v_what, ''), nullif(v_car, ''),
      -- silent drops 6: a ride still waiting for a driver says so
      case when r.driver_id is null then public._frag('publish.no_driver') end)));
end $$;

CREATE OR REPLACE FUNCTION "public"."publish_siddur"("p_department_id" "uuid", "p_week_start" "date", "p_profile_scores" "jsonb" DEFAULT '[]'::"jsonb", "p_expected_fingerprint" "text" DEFAULT NULL::"text", "p_policy_scores" "jsonb" DEFAULT '[]'::"jsonb", "p_days" "date"[] DEFAULT NULL::"date"[], "p_allow_unanswered" boolean DEFAULT false, "p_allow_driverless" boolean DEFAULT false) RETURNS "uuid"
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
  v_items jsonb; v_dates date[]; v_extra text; v_old_ids uuid[]; v_old record; v_notif uuid; v_lines text; v_days_txt text;
  v_prev_publishing text := coalesce(current_setting('app.publishing', true), '');
  v_prev_status text;
  v_event public.notification_event;
  policy_score jsonb;
  n int; served_n int; total numeric; served_total numeric;
begin
  -- REQ §13.138 (c): publishing's own notices are never held as board changes.
  perform set_config('app.publishing', 'on', true);
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
    where (item->>'day')::date=any(v_days) and (item->>'alternativeProposals')::int>0)
  then raise exception 'publication_alternatives_pending';end if;
  if exists(select 1 from jsonb_array_elements(readiness) item
    where (item->>'day')::date=any(v_days) and (item->>'draftProposals')::int>0)
  then raise exception 'publication_drafts';end if;
  -- REQ §13.138 (g): board changes not yet told block the day, not bypassable either.
  if exists(select 1 from jsonb_array_elements(readiness) item
    where (item->>'day')::date=any(v_days) and coalesce((item->>'heldNotices')::int,0)>0)
  then raise exception 'publication_held_notices';end if;
  -- R20B7 (owner 2026-11-14): a pending proposal blocks the day, not bypassable - a late "yes" must never change a
  -- published ride behind the Sadran's back. Answer it, withdraw it, or mark it agreed (agree_proposals_offline).
  if exists(select 1 from jsonb_array_elements(readiness) item
    where (item->>'day')::date=any(v_days) and (item->>'pendingProposals')::int>0)
  then raise exception 'publication_proposals_pending';end if;
  if not coalesce(p_allow_unanswered,false) and exists(select 1 from jsonb_array_elements(readiness) item
    where (item->>'day')::date=any(v_days) and (item->>'incompleteAssignments')::int>0)
  then raise exception 'publication_unanswered';end if;
  -- R12M3 (REQ §13.119): rides still without a driver are not "unanswered"; the UI asks "publish anyway?" and sends
  -- p_allow_driverless (the older p_allow_unanswered keeps meaning "publish despite everything open", driverless included).
  if not coalesce(p_allow_driverless,false) and not coalesce(p_allow_unanswered,false) and exists(select 1 from jsonb_array_elements(readiness) item
    where (item->>'day')::date=any(v_days) and (item->>'missingDriverRides')::int>0)
  then raise exception 'publication_driverless';end if;
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
    -- R13U9: a request whose offer lapses at this publish is stored with the status it returns to (the offer's
    -- previous_status), so the next publish does not report "proposed -> waitlisted" as news.
    'requests', (select coalesce(jsonb_agg(jsonb_build_object(
                    'id', q.id, 'requester_id', q.requester_id,
                    'status', coalesce(case when q.status = 'proposed'
                        and (coalesce(q.depart_at,q.return_at) at time zone 'Asia/Jerusalem')::date = any(v_days) then
                      (select pp.previous_status from public.proposals pp where pp.request_id = q.id and pp.status = 'sent'
                         and (pp.type not in ('shift','merge') or pp.created_via <> 'sadran'
                              or (coalesce(q.depart_at,q.return_at) at time zone 'Asia/Jerusalem')::date < (now() at time zone 'Asia/Jerusalem')::date)
                       order by pp.created_at limit 1) end, q.status),
                    'status_reason', q.status_reason)), '[]')
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
        coalesce(c.name,dest.name,q.destination_text,'') as line_place,
        -- R13U9: an offer this publish lapses (the rule of expire_proposals) — its line goes in this notice
        q.status = 'proposed' and exists (select 1 from public.proposals pp where pp.request_id = q.id and pp.status = 'sent'
          and (pp.type not in ('shift','merge') or pp.created_via <> 'sadran'
               or (coalesce(q.depart_at,q.return_at) at time zone 'Asia/Jerusalem')::date < (now() at time zone 'Asia/Jerusalem')::date)) as offer_lapses
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
          -- REQ §13.204 (a): "removed" only for a request the previous publish showed placed; one that became
          -- waitlisted since gets "on the waiting list"; one filed since the previous publish has no line (its
          -- member was told at filing) - was: every new waitlisted request read publish.removed.
          when x.id is null then case
            when s.prev_status in ('assigned', 'merged') then public._frag('publish.removed')
            when s.prev_status is not null and s.prev_status is distinct from s.status::text and s.status = 'waitlisted'
              then public._frag('publish.now_waitlisted')
            else '' end
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
          -- a one-way request has no return: its line keeps the day and departure (was: the whole part went null)
          public.day_date_label(line_dt) || ' ' ||
            concat_ws('–', to_char(line_depart at time zone 'Asia/Jerusalem','HH24:MI'),
                           to_char(line_return at time zone 'Asia/Jerusalem','HH24:MI')),
          nullif(line_place,'')
        ) as request_line
      from scoped s
    ), extra_rides as (
      -- RC1B7 (owner 2026-10-29): a newly published ride the member is on without a request of their own on it -
      -- driving it for someone else, or a companion named on a request it serves - is one of "your rides" too
      -- (my-rides lists it). The line is the ride's line as its served request reads it.
      select distinct on (p.pid, x.id) p.pid as requester_id, p.request_id,
        (x.starts_at at time zone 'Asia/Jerusalem')::date as request_day, x.starts_at as line_start,
        public._publish_ride_line(p.request_id, x.id, p.pid) as line
      from public.rides x
      cross join lateral (
        select x.driver_id as pid, rr.request_id from public.ride_requests rr where rr.ride_id = x.id
        union all
        select rc.profile_id, rr.request_id from public.ride_requests rr
        join public.request_companions rc on rc.request_id = rr.request_id where rr.ride_id = x.id
      ) p
      where x.department_id = p_department_id and x.week_start = p_week_start and x.status <> 'cancelled'
        and (x.starts_at at time zone 'Asia/Jerusalem')::date = any(v_days)
        and (v_prev is null or not coalesce((x.starts_at at time zone 'Asia/Jerusalem')::date = any(v_prior_days), false))
        and p.pid is not null
        and not exists (select 1 from public.ride_requests rr2 join public.requests q2 on q2.id = rr2.request_id
                        where rr2.ride_id = x.id and q2.requester_id = p.pid)
      order by p.pid, x.id, p.request_id
    ), pub_ride_lines as (
      -- R5U4: one line per ride the member is on (a pickup is its own ride and its own line); a request with
      -- no live ride keeps its single requested-time line. Rides outside the published days are not listed.
      -- R14B4: one line per ride, even when the request rides it on two legs (two ride_requests rows).
      select distinct on (c.id, x.id) c.requester_id, c.id as request_id, c.request_day, x.starts_at as line_start,
        public._publish_ride_line(c.id, x.id, c.requester_id) as line
      from classified c
      join public.ride_requests rr on rr.request_id = c.id
      join public.rides x on x.id = rr.ride_id and x.status <> 'cancelled'
      where c.event_kind = 'published'
        and (x.starts_at at time zone 'Asia/Jerusalem')::date = any(v_days)
      union all
      -- R10B4: a request with no live ride is not one of "your rides"; a waitlisted one gets its own line
      -- ("on the waiting list: ..."), any other (denied, still open) is left out.
      select c.requester_id, c.id, c.request_day, coalesce(c.line_depart, c.line_dt),
        public._frag(case when c.offer_lapses then 'publish.offer_expired' else 'publish.waitlisted' end, jsonb_build_object('line', c.request_line))
      from classified c
      where c.event_kind = 'published' and (c.status = 'waitlisted' or c.offer_lapses)
        and not exists (select 1 from public.ride_requests rr join public.rides x on x.id = rr.ride_id
                        where rr.request_id = c.id and x.status <> 'cancelled')
      union all
      -- silent drops 6 (owner 2026-11-24): a two-way request with one way on a ride - the way still waiting gets its own
      -- "on the waiting list" line (the ride line alone read like the whole trip)
      select c.requester_id, c.id, c.request_day, case when cov.missing = 'out' then q.depart_at else q.return_at end,
        public._frag('publish.waitlisted', jsonb_build_object('line', public._publish_waiting_leg_line(c.id, cov.missing)))
      from classified c
      join public.requests q on q.id = c.id
      cross join lateral (
        select case when bool_or(rr.covers_out) and not bool_or(rr.covers_return) then 'return'
                    when bool_or(rr.covers_return) and not bool_or(rr.covers_out) then 'out' end as missing
        from public.ride_requests rr join public.rides x on x.id = rr.ride_id
        where rr.request_id = c.id and x.status <> 'cancelled'
      ) cov
      where c.event_kind = 'published' and q.depart_at is not null and q.return_at is not null and q.series_id is null
        and cov.missing is not null
      union all
      select e.requester_id, e.request_id, e.request_day, e.line_start, e.line from extra_rides e
    ), days_agg as (
      select requester_id, event_kind, string_agg(public.day_date_label(request_day), ', ' order by request_day) as days_list,
        array_agg(request_day order by request_day) as days_arr
      from (select distinct c.requester_id, c.event_kind, c.request_day from classified c where c.event_kind is not null
        and (c.event_kind <> 'published' or c.status = 'waitlisted' or c.offer_lapses or exists (select 1 from public.ride_requests rr join public.rides x on x.id = rr.ride_id
                where rr.request_id = c.id and x.status <> 'cancelled'))
        union select e.requester_id, 'published', e.request_day from extra_rides e) d
      group by requester_id, event_kind
    ), chg_lines as (
      select rc.requester_id, rc.request_id, rc.request_day,
        public._frag('publish.line', jsonb_build_object('route', rc.route, 'day', rc.line_day, 'changeLine', rc.line_change)) as line,
        row_number() over (partition by rc.requester_id order by rc.request_day, rc.request_id, rc.ride_id) as rn,
        count(*) over (partition by rc.requester_id) as tot
      from ride_chg rc join classified cl on cl.id = rc.request_id and cl.event_kind = 'outcome_changed'
      where rc.line_change <> ''
    ), lines_agg as (
      -- R14B4: an identical line (the same ride reached by two of the member's requests) appears once.
      select requester_id, 'published'::text as event_kind,
        string_agg(line, chr(10) order by line_start, line) as lines,
        (array_agg(request_id order by line_start, request_id))[1] as first_id,
        jsonb_agg(jsonb_build_object('t', line_start, 'line', line) order by line_start, line) as items
      from (select requester_id, line, min(line_start) as line_start, (array_agg(request_id order by line_start, request_id))[1] as request_id
            from pub_ride_lines group by requester_id, line) pl
      group by requester_id
      union all
      select cl.requester_id, 'outcome_changed',
        string_agg(cl.line, chr(10) order by cl.rn) filter (where cl.rn <= 3)
          || case when max(cl.tot) > 3 then chr(10) || public._frag('publish.more', jsonb_build_object('count', (max(cl.tot) - 3)::text)) else '' end,
        (array_agg(cl.request_id order by cl.rn))[1],
        null::jsonb
      from chg_lines cl group by cl.requester_id
    ), per_kind as (
      select l.requester_id, l.event_kind, d.days_list, d.days_arr, l.lines, l.first_id, l.items
      from lines_agg l join days_agg d using (requester_id, event_kind)
    )
    -- R13U9: ONE notice per member per publish — newly published days and changes on days already public share it
    -- (`published` first; its days are disjoint from the changed ones).
    select k.requester_id,
      case when bool_or(k.event_kind = 'published') then 'published' else 'outcome_changed' end as event_kind,
      string_agg(k.days_list, ', ' order by k.event_kind desc) as days_list,
      string_agg(k.lines, chr(10) order by k.event_kind desc) as lines,
      (array_agg(k.first_id order by k.event_kind desc))[1] as first_id,
      (array_agg(k.items) filter (where k.event_kind = 'published'))[1] as items,
      (array_agg(k.lines) filter (where k.event_kind = 'outcome_changed'))[1] as extra,
      (select array_agg(distinct d order by d) from per_kind k2 cross join lateral unnest(k2.days_arr) d where k2.requester_id = k.requester_id) as days_arr
    from per_kind k group by k.requester_id
  loop
    v_event := v_req.event_kind::public.notification_event;
    v_items := coalesce(v_req.items, '[]'::jsonb); v_dates := v_req.days_arr; v_extra := v_req.extra; v_old_ids := null;
    if v_event = 'published' then
      -- R14B3 (owner 2026-10-23, "merge if unread"): publishing in several calls must not send several notices. An
      -- earlier `published` notice of this week that the member has not opened is replaced by this one, which lists
      -- the lines and days of both (identical lines once, in day order); the member was already pushed for it, so the
      -- merged notice is inbox only. One the member opened stays, and the new notice pushes once.
      for v_old in
        select n.id, n.data from public.notifications n
        where n.recipient_id = v_req.requester_id and n.event = 'published' and n.week_start = p_week_start
          and n.read_at is null and n.data ? 'pub_items' order by n.created_at, n.id
      loop
        v_old_ids := array_append(v_old_ids, v_old.id);
        v_items := (v_old.data -> 'pub_items') || v_items;
        v_dates := array(select distinct d from unnest(v_dates || array(select jsonb_array_elements_text(v_old.data -> 'pub_days')::date)) d order by d);
        if coalesce(v_old.data ->> 'pub_extra', '') <> '' then
          v_extra := concat_ws(chr(10), v_old.data ->> 'pub_extra', v_extra);
        end if;
      end loop;
      select string_agg(line, chr(10) order by t, line) into v_lines
      from (select e ->> 'line' as line, min((e ->> 't')::timestamptz) as t from jsonb_array_elements(v_items) e group by e ->> 'line') x;
      if v_extra is not null then
        select string_agg(l, chr(10) order by o) into v_extra
        from (select l, min(o) as o from unnest(string_to_array(v_extra, chr(10))) with ordinality u(l, o) group by l) y;
        v_lines := concat_ws(chr(10), v_lines, v_extra);
      end if;
    else
      v_lines := v_req.lines;
    end if;
    select string_agg(public.day_date_label(d), ', ' order by d) into v_days_txt from unnest(v_dates) d;
    v_notif := public.enqueue_notification(v_req.requester_id, v_event, p_department_id, p_week_start,
      case when v_event = 'published' then jsonb_build_object('days', v_days_txt, 'outcomeLine', v_lines)
        else jsonb_build_object('days', v_days_txt, 'diffLine', v_lines) end,
      case when v_event = 'published' then jsonb_build_object('request_id', v_req.first_id, 'pub_items', v_items,
             'pub_days', to_jsonb(v_dates), 'pub_extra', v_extra)
        else jsonb_build_object('request_id', v_req.first_id) end,
      format('%s:%s:%s', v_event, v_version_id, v_req.requester_id));
    if v_notif is not null and v_old_ids is not null then
      delete from public.notifications where id = any(v_old_ids);
      delete from public.push_outbox where notification_id = v_notif;
    end if;
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

  perform set_config('app.publishing', v_prev_publishing, true);
  return v_version_id;
end;
$$;

CREATE OR REPLACE FUNCTION "public"."apply_proposal"("p_proposal_id" "uuid") RETURNS "uuid"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
declare
  v_prop record;
  v_req record;
  v_ride_id uuid;
  v_leg jsonb;
  v_has_driver_leg boolean;
  v_is_auto_apply boolean;
  v_existing public.rides%rowtype;
  v_old record;
  v_home uuid;
  host public.rides%rowtype;
  required_party uuid;
  combined_start timestamptz;combined_end timestamptz;
  route_before jsonb:='{}'::jsonb;
  v_chain_plans jsonb:='{}'::jsonb;
  v_has_places boolean; route_old int; route_new int; shift_start timestamptz; shift_end timestamptz;
  gap_override smallint;
  v_origin_result jsonb;
  v_leg_txt text; v_merge_out boolean:=false; v_merge_ret boolean:=false; v_snap jsonb; v_served_status public.request_status;
  v_old_dep timestamptz; v_old_ret timestamptz; v_old_car uuid; v_old_series_dep timestamptz; v_old_series_ret timestamptz;
  v_rv_joiner jsonb; v_rvs jsonb:='{}'::jsonb; v_rcpt record; v_byname text; v_tc text:=''; v_variant text; v_vars jsonb;
  v_sib record; v_sprop record;
  v_new_car text; v_old_car_name text; v_change_line text:=''; v_snap_fp text; v_explicit boolean; v_src_fp jsonb; v_cur_host_fp text;
begin
  select * into v_prop from public.proposals where id = p_proposal_id for update;
  if v_prop is null then raise exception 'proposal_not_found' using errcode = 'P0001'; end if;

  v_is_auto_apply := coalesce(current_setting('app.auto_applying_proposal', true), '') = 'on';
  if not v_is_auto_apply and not public.can_manage_week(v_prop.department_id, v_prop.week_start) then
    raise exception 'not_authorized' using errcode = 'P0001';
  end if;
  if v_prop.status <> 'accepted' then raise exception 'proposal_not_accepted' using errcode = 'P0001'; end if;

  select * into v_req from public.requests where id = v_prop.request_id for update;
  select home_destination_id into v_home from public.departments where id=v_prop.department_id;
  perform set_config('app.audit_reason', 'apply_proposal', true);
  perform set_config('app.system_status_transition', 'on', true);
  perform set_config('app.applying_proposal', p_proposal_id::text, true);
  -- REQ §13.111 (a): the Sadran waived the large trunk for this proposal: the placement stamps the waiver (assert_ride_seats_fit).
  if v_prop.created_via = 'sadran' and coalesce((v_prop.payload ->> 'allow_small_trunk')::boolean, false) then
    perform public._small_trunk_mode(true);
  end if;
  -- REQ §13.175 (a): the Sadran accepted a long detour for this merge.
  perform public._long_detour_mode(v_prop.created_via = 'sadran' and coalesce((v_prop.payload ->> 'allow_long_detour')::boolean, false));
  -- Old values for the old -> new notification lines (REQ §13.101 b), taken before anything changes.
  -- R14B5: "old" is what the member holds now - the booked ride's times once a ride carries the request.
  select bt.dep, bt.ret into v_old_dep, v_old_ret from public._request_booked_times(v_req.id) bt;
  select rd.car_id into v_old_car from public.rides rd join public.ride_requests rr on rr.ride_id = rd.id
  where rr.request_id = v_req.id and rd.status <> 'cancelled' order by rd.starts_at limit 1;

  if v_prop.type = 'deny' then
    update public.requests set status = 'denied', status_reason = coalesce(v_prop.payload ->> 'reason', 'DENIED_BY_SADRAN')
    where id = v_prop.request_id;
  elsif v_prop.type = 'external' then
    -- REQ §13.136 g: "manage on your own" for a request that is placed right now (the solver offers it so someone without
    -- a car gets this one) gives the booking up first, as a withdraw does; an unplaced request has nothing to release.
    if exists (select 1 from public.ride_requests rr join public.rides rd on rd.id = rr.ride_id
               where rr.request_id = v_req.id and rd.status <> 'cancelled') then
      perform public.release_request_booking(v_req.id);
    end if;
    update public.requests set status = 'external', status_reason = coalesce(v_prop.payload ->> 'reason', 'EXTERNAL')
    where id = v_prop.request_id;
    -- REQ §13.105 / QA run 5 R5B6: "no car" for one leg of a multi-day request is "no car" for the whole trip - every other
    -- still-unplaced leg of the series resolves the same way (their own open proposals are withdrawn first), instead of
    -- leaving the siblings on the waiting list next to an external leg.
    if v_req.series_id is not null then
      for v_sib in select q.id from public.requests q
          where q.series_id = v_req.series_id and q.id <> v_req.id
            and q.status in ('submitted', 'waitlisted', 'proposed') order by q.id for update loop
        for v_sprop in select p.id, p.status from public.proposals p
            where p.request_id = v_sib.id and p.status in ('draft', 'sent', 'accepted') order by p.id loop
          if v_sprop.status = 'draft' then update public.proposals set status = 'withdrawn' where id = v_sprop.id;
          else perform public.proposal_system_withdraw(v_sprop.id, 'withdrawn_edit'); end if;
        end loop;
        update public.requests set status = 'external', status_reason = coalesce(v_prop.payload ->> 'reason', 'EXTERNAL')
        where id = v_sib.id;
      end loop;
    end if;
  elsif v_prop.type = 'alternative' then
    -- REQ §13.112 (a): the member accepted their own plan B; the original main trip is kept whole in request_alternatives.
    v_ride_id := public._apply_alternative(v_prop.id);
  elsif v_prop.type = 'origin' then
    update public.requests set
      origin_id = (v_prop.payload ->> 'origin_id')::uuid, origin_text = null,
      preferred_car_id = (v_prop.payload ->> 'car_id')::uuid,
      status = 'submitted'
    where id = v_prop.request_id;
    -- REQ §13.102 R2B16: the new origin is the start, not also a stop of the outbound leg.
    delete from public.request_stops where request_id = v_prop.request_id and leg = 'out'
      and place_id = (v_prop.payload ->> 'origin_id')::uuid;
    v_origin_result := public.try_auto_approve(v_prop.request_id);
    if coalesce(v_origin_result ->> 'status', '') <> 'assigned' then
      raise exception 'origin_change_unavailable' using errcode = 'P0001';
    end if;
    v_ride_id := (v_origin_result ->> 'ride_id')::uuid;
  elsif v_prop.type = 'shift' and v_prop.payload ? 'series_span' then
    -- REQ §13.101 j: fewer days for a multi-day request, held on one car.
    if v_prop.created_via = 'sadran' then
      perform public.assert_private_car_owner_only((v_prop.payload->>'car_id')::uuid, v_prop.created_by, v_req.requester_id);
    end if;
    select min(q.depart_at), max(q.return_at) into v_old_series_dep, v_old_series_ret
    from public.requests q where q.series_id = v_req.series_id and q.status not in ('withdrawn', 'cancelled');
    v_ride_id := public._apply_series_span(v_req.id, v_prop.payload -> 'series_span', (v_prop.payload ->> 'car_id')::uuid);
  elsif v_prop.type = 'shift' then
    v_has_places := v_prop.payload ? 'origin_id' or v_prop.payload ? 'origin_text' or v_prop.payload ? 'destination_id'
      or v_prop.payload ? 'destination_text' or v_prop.payload ? 'stops';
    if v_has_places then
      perform public._assert_shift_places(v_req.id, v_req.department_id, v_prop.payload);
      route_old := (case when v_req.depart_at is not null then coalesce(public.request_leg_route_minutes(v_req.id,'out'),0) else 0 end)
        + (case when v_req.return_at is not null then coalesce(public.request_leg_route_minutes(v_req.id,'return'),0) else 0 end);
      update public.requests set
        origin_id = case when v_prop.payload ? 'origin_id' or v_prop.payload ? 'origin_text' then nullif(v_prop.payload ->> 'origin_id','')::uuid else origin_id end,
        origin_text = case when v_prop.payload ? 'origin_id' or v_prop.payload ? 'origin_text' then nullif(btrim(coalesce(v_prop.payload ->> 'origin_text','')),'') else origin_text end,
        destination_id = case when v_prop.payload ? 'destination_id' or v_prop.payload ? 'destination_text' then nullif(v_prop.payload ->> 'destination_id','')::uuid else destination_id end,
        destination_text = case when v_prop.payload ? 'destination_id' or v_prop.payload ? 'destination_text' then nullif(btrim(coalesce(v_prop.payload ->> 'destination_text','')),'') else destination_text end
      where id = v_req.id;
      if v_prop.payload ? 'stops' then
        perform public.replace_request_stops(v_req.id, v_req.department_id,
          coalesce(nullif(v_prop.payload ->> 'return_at','')::timestamptz, v_req.return_at) is not null, v_prop.payload -> 'stops');
      end if;
      select * into v_req from public.requests where id = v_prop.request_id;
      -- silent drops 7 (owner 2026-11-24): a merged guest the new route no longer picks up goes back to waiting, told
      perform public._release_guests_off_route(v_req.id);
      route_new := (case when v_req.depart_at is not null then coalesce(public.request_leg_route_minutes(v_req.id,'out'),0) else 0 end)
        + (case when v_req.return_at is not null then coalesce(public.request_leg_route_minutes(v_req.id,'return'),0) else 0 end);
    end if;
    if v_prop.payload ? 'car_id' and v_req.trip_type is distinct from 'round_trip' then
      -- REQ §13.94: one_way / drop_off place on the named car by trip type (_shift_place_on_car).
      v_ride_id := public._shift_place_on_car(v_prop.id);
    elsif v_prop.payload ? 'car_id' then
      select rd.* into v_existing from public.rides rd join public.ride_requests rr on rr.ride_id=rd.id
      where rr.request_id=v_req.id and rr.role='driver' and rd.status<>'cancelled' order by rd.starts_at limit 1 for update of rd;
      perform public.assert_private_car_owner_only((v_prop.payload->>'car_id')::uuid, v_prop.created_by, v_req.requester_id);
      shift_start := coalesce((v_prop.payload->>'depart_at')::timestamptz, v_existing.starts_at, v_req.depart_at);
      shift_end := coalesce((v_prop.payload->>'return_at')::timestamptz, v_existing.ends_at, v_req.return_at);
      if v_has_places and not (v_prop.payload ? 'return_at') and v_existing.id is not null and coalesce(route_new,0) > coalesce(route_old,0) then
        shift_end := public._round_up_ride_end(shift_start, shift_end + make_interval(mins => route_new - route_old));
      end if;
      if v_prop.created_via='sadran' then
        gap_override:=public.prepare_manual_ride_window((v_prop.payload->>'car_id')::uuid,v_prop.week_start,shift_start,shift_end,v_existing.id);
      end if;
      if v_existing.id is not null then
        if v_prop.created_via<>'sadran' and exists(select 1 from public.ride_requests rr where rr.ride_id=v_existing.id and rr.request_id<>v_req.id) then raise exception 'shared_ride_requires_sadran'; end if;
        update public.rides set turnaround_override_minutes=gap_override,car_id=(v_prop.payload->>'car_id')::uuid,
          starts_at=shift_start,
          ends_at=shift_end,
          is_pinned=true,pin_reason='PROPOSAL_APPLIED' where id=v_existing.id returning id into v_ride_id;
      else
        insert into public.rides(department_id,week_start,car_id,starts_at,ends_at,origin_id,destination_id,driver_id,status,is_pinned,pin_reason,created_by,turnaround_override_minutes)
        values(v_prop.department_id,v_prop.week_start,(v_prop.payload->>'car_id')::uuid,
          shift_start,shift_end,
          coalesce((v_prop.payload->>'origin_id')::uuid,v_req.origin_id,v_home),coalesce((v_prop.payload->>'destination_id')::uuid,v_req.origin_id,v_home),v_req.requester_id,
          case when public.is_week_public(v_prop.department_id,v_prop.week_start) then 'confirmed'::public.ride_status else 'draft'::public.ride_status end,
          true,'PROPOSAL_APPLIED',v_prop.created_by,gap_override) returning id into v_ride_id;
        insert into public.ride_requests(ride_id,request_id,role,leg,car_mode) values(v_ride_id,v_req.id,'driver','both','keep');
      end if;
      update public.requests set status='assigned',status_reason='PROPOSAL_APPLIED' where id=v_req.id;
      perform public.assert_ride_request_day(v_ride_id);
      perform public.assert_ride_seats_fit(v_ride_id);
      perform public.assert_car_chain((v_prop.payload->>'car_id')::uuid,v_prop.week_start);
      if v_existing.car_id is not null and v_existing.car_id<>(v_prop.payload->>'car_id')::uuid then perform public.assert_car_chain(v_existing.car_id,v_prop.week_start); end if;
    elsif not (v_prop.payload ? 'depart_at' or v_prop.payload ? 'return_at' or v_prop.payload ? 'trip_shape'
               or v_prop.payload ? 'needs_car_at_destination')
          and exists(select 1 from public.ride_requests rr join public.rides r on r.id=rr.ride_id
                     where rr.request_id=v_req.id and r.status<>'cancelled') then
      -- REQ §13.100 QB22: an edit-route shift of a request that live rides still serve changes the route only.
      select case when exists(select 1 from public.ride_requests rr join public.rides r on r.id=rr.ride_id
                              where rr.request_id=v_req.id and r.status<>'cancelled' and r.needs_driver) then 'waitlisted'
                  when exists(select 1 from public.ride_requests rr join public.rides r on r.id=rr.ride_id
                              where rr.request_id=v_req.id and r.status<>'cancelled' and rr.role='driver') then 'assigned'
                  else 'merged' end::public.request_status into v_served_status;
      update public.requests set status=v_served_status,
        status_reason=case when v_served_status='waitlisted' then 'UNMET_NEEDS_DRIVER' else 'PROPOSAL_APPLIED' end
      where id=v_req.id;
    else
      update public.requests set
        depart_at = coalesce((v_prop.payload ->> 'depart_at')::timestamptz, depart_at),
        return_at = coalesce((v_prop.payload ->> 'return_at')::timestamptz, return_at),
        trip_shape = coalesce((v_prop.payload ->> 'trip_shape')::public.trip_shape, trip_shape),
        needs_car_at_destination = coalesce((v_prop.payload ->> 'needs_car_at_destination')::boolean, needs_car_at_destination),
        status = 'submitted', status_reason = 'PROPOSAL_APPLIED_PENDING_ASSIGNMENT'
      where id = v_prop.request_id;
    end if;
  elsif v_prop.type = 'merge' then
    -- REQ §13.101 b: everyone already on the ride is told every time someone joins; their old -> new lines are
    -- read now, before the ride moves.
    v_rv_joiner := public.proposal_reader_vars(v_prop.id, v_req.requester_id);
    select coalesce(jsonb_object_agg(y.pid::text, public.proposal_reader_vars(v_prop.id, y.pid)), '{}'::jsonb) into v_rvs
    from (select distinct x.pid from (
            select rd.driver_id as pid from public.rides rd
            where rd.id in (select (l->>'ride_id')::uuid from jsonb_array_elements(coalesce(v_prop.payload->'legs','[]')) l)
            union
            select q.requester_id from public.ride_requests rr join public.requests q on q.id = rr.request_id
            where rr.ride_id in (select (l->>'ride_id')::uuid from jsonb_array_elements(coalesce(v_prop.payload->'legs','[]')) l)
          ) x where x.pid is not null and x.pid <> v_req.requester_id) y;
    if not exists(select 1 from public.proposal_parties where proposal_id=v_prop.id and profile_id=v_req.requester_id and response='accepted')
      or exists(select 1 from public.proposal_parties where proposal_id=v_prop.id and response<>'accepted') then raise exception 'proposal_consent_required'; end if;
    v_explicit := coalesce((v_prop.payload->>'window_explicit')::boolean,false);
    if v_prop.payload ? 'request_fingerprint' and v_prop.payload->>'request_fingerprint' is distinct from public.merge_request_fingerprint(v_req.id) then perform public.raise_stale_version(); end if;
    for host in select * from public.rides where id in(select (value->>'ride_id')::uuid from jsonb_array_elements(coalesce(v_prop.payload->'legs','[]'))) order by id for update loop
      if host.department_id<>v_prop.department_id or host.week_start<>v_prop.week_start or host.status='cancelled' then raise exception 'ride_not_found'; end if;
      -- REQ §13.99: a private car takes passengers only through its owner (ask-to-join to the owner, or the owner's own act).
      if v_prop.created_via<>'ask_to_join' then
        perform public.assert_private_car_owner_only(host.car_id, v_prop.created_by, v_req.requester_id);
      end if;
      -- REQ §13.100 QB9: another passenger merging in moves the version; what must still hold is that the host is otherwise unchanged (ride_merge_fingerprint).
      v_snap:=v_prop.payload->'host_snapshots'->host.id::text;
      if v_snap is not null then
        -- REQ §13.102 R2B1: publication flips a draft ride to confirmed (and bumps its version); that alone never
        -- makes an answered proposal stale, so the stored fingerprint is also matched with the draft/confirmed status.
        -- REQ §13.103 R3B1: the fingerprint ignores who drives (a volunteer assigned meanwhile changes nothing the
        -- answer depended on); feasibility is re-validated below (_merge_check, seats, chain).
        if not public._ride_fp_matches(host.id, v_snap->>'fp') then
          perform public.raise_stale_version();
        end if;
      elsif v_prop.payload ? 'host_versions' and host.version is distinct from (v_prop.payload->'host_versions'->>host.id::text)::int then perform public.raise_stale_version(); end if;
      -- consent: the driver and every passenger who was a party; a passenger who joined after the offer needs none
      for required_party in select host.driver_id where host.driver_id is not null union select q.requester_id from public.ride_requests rr join public.requests q on q.id=rr.request_id where rr.ride_id=host.id loop
        if exists(select 1 from public.proposal_parties where proposal_id=v_prop.id and profile_id=required_party)
           and not exists(select 1 from public.proposal_parties where proposal_id=v_prop.id and profile_id=required_party and response='accepted') then raise exception 'proposal_consent_required'; end if;
      end loop;
    end loop;
    v_src_fp := coalesce(v_prop.payload->'source_snapshots','{}'::jsonb);
    if exists(select 1 from jsonb_each_text(coalesce(v_prop.payload->'source_versions','{}')) expected left join public.rides r on r.id=expected.key::uuid
      where r.id is null or r.status='cancelled'
         or (r.version is distinct from expected.value::int
             and (not (v_src_fp ? expected.key)
                  or not public._ride_fp_matches(r.id, v_src_fp->expected.key->>'fp')))) then perform public.raise_stale_version(); end if;
    -- CM1 phase 2: a chain's plan (its driver) is read while the guest is still on its own ride
    for host in select * from public.rides where id in(select (value->>'ride_id')::uuid from jsonb_array_elements(coalesce(v_prop.payload->'legs','[]')) where coalesce(value->>'leg','both')='both') order by id loop
      v_chain_plans:=v_chain_plans||jsonb_build_object(host.id::text,public._merge_chain_plan(host.id,v_req.id,'both'));
    end loop;
    -- Replace the request's prior solo assignment; do not leave a duplicate driver leg.
    select coalesce(bool_or(coalesce(l->>'leg','both') in ('out','both')),false), coalesce(bool_or(coalesce(l->>'leg','both') in ('return','both')),false)
      into v_merge_out, v_merge_ret from jsonb_array_elements(coalesce(v_prop.payload->'legs','[]')) l;
    for v_old in select rd.* from public.rides rd join public.ride_requests rr on rr.ride_id=rd.id
      where rr.request_id=v_req.id and rd.status<>'cancelled' and not exists(
        select 1 from jsonb_array_elements(coalesce(v_prop.payload->'legs','[]')) desired_leg(value) where (desired_leg.value->>'ride_id')::uuid=rd.id
      ) and exists(select 1 from public.ride_requests rr2 where rr2.ride_id=rd.id and rr2.request_id=v_req.id
                   and ((rr2.covers_out and v_merge_out) or (rr2.covers_return and v_merge_ret)))   -- QB2: only the replaced leg's booking
      order by rd.id for update of rd loop
      if v_old.driver_id=v_req.requester_id or (v_old.needs_driver and not exists(select 1 from public.ride_requests where ride_id=v_old.id and request_id<>v_req.id)) then
        if exists(select 1 from public.ride_requests where ride_id=v_old.id and request_id<>v_req.id) or v_old.origin_id<>v_old.destination_id then raise exception 'shared_ride_requires_sadran'; end if;
        update public.rides set status='cancelled',cancelled_at=now(),cancelled_by=v_req.requester_id,cancel_reason='MERGED_BY_CONSENT' where id=v_old.id;
      end if;
      delete from public.ride_requests where ride_id=v_old.id and request_id=v_req.id;
      perform public.assert_car_chain(v_old.car_id,v_old.week_start);
    end loop;
    -- REQ §13.95 H1: validity + added driving of every host before the guest boards.
    for host in select * from public.rides where id in(select (value->>'ride_id')::uuid from jsonb_array_elements(coalesce(v_prop.payload->'legs','[]'))) order by id loop
      select case when count(distinct coalesce(l->>'leg','both'))>1 or bool_or(coalesce(l->>'leg','both')='both') then 'both'
                  else max(coalesce(l->>'leg','both')) end into v_leg_txt
      from jsonb_array_elements(coalesce(v_prop.payload->'legs','[]')) l where (l->>'ride_id')::uuid=host.id and coalesce(l->>'role','passenger')<>'driver';
      if v_leg_txt is not null then
        route_before:=route_before||jsonb_build_object(host.id::text,public._merge_check(host.id,v_req.id,v_leg_txt::public.ride_leg));
        if not ((route_before->host.id::text->>'ok')::boolean) then raise exception '%',route_before->host.id::text->>'error' using errcode='P0001'; end if;
        -- REQ §13.102 R2B2: the window is always the ride's current one plus the route extension; if that would eat the
        -- car's turnaround the merge is refused with a clear error (only an explicit consented window may be tight).
        if coalesce((route_before->host.id::text->>'turnaround_conflict')::boolean,false)
           and not (v_explicit and coalesce((v_prop.payload->>'allow_tight_turnaround')::boolean,false)) then
          raise exception 'merge_turnaround_conflict' using errcode='P0001';
        end if;
      end if;
    end loop;
    v_has_driver_leg := false;
    for v_leg in select * from jsonb_array_elements(coalesce(v_prop.payload -> 'legs', '[]')) loop
      v_ride_id := (v_leg ->> 'ride_id')::uuid;
      insert into public.ride_requests (ride_id, request_id, role, leg, car_mode, detour_minutes)
      values (v_ride_id, v_prop.request_id, coalesce((v_leg ->> 'role')::public.ride_role, 'passenger'),
        coalesce((v_leg ->> 'leg')::public.ride_leg, 'both'), (v_leg ->> 'car_mode')::public.leg_car_mode,
        coalesce((v_prop.payload ->> 'detour_minutes')::smallint, 0))
      on conflict (ride_id, request_id, leg) do update set car_mode = excluded.car_mode;
      update public.rides set is_pinned = true, pin_reason = 'PROPOSAL_APPLIED' where id = v_ride_id;
      if (v_leg ->> 'role') = 'driver' then
        v_has_driver_leg := true;
      end if;
    end loop;
    -- CM1 phase 2: a chained merge writes its chain (the short trip's row, the driver, the long trip as the route base)
    for host in select * from public.rides where id in(select (value->>'ride_id')::uuid from jsonb_array_elements(coalesce(v_prop.payload->'legs','[]'))) order by id loop
      if jsonb_typeof(route_before->host.id::text->'chain')='object' then
        perform public._apply_chain(host.id,(route_before->host.id::text->'chain')-'route'
          ||jsonb_build_object('driver_id',coalesce(v_chain_plans->host.id::text->>'driver_id',route_before->host.id::text->'chain'->>'driver_id')));
      end if;
    end loop;
    for host in select * from public.rides where id in(select (value->>'ride_id')::uuid from jsonb_array_elements(coalesce(v_prop.payload->'legs','[]'))) order by id for update loop
      -- A legacy payload window (`starts_at`/`ends_at`, the consented expanded merge) still widens the host;
      -- the route extension (start earlier / end later, REQ §13.95) is applied on top of it.
      combined_start:=least(host.starts_at,case when v_explicit then coalesce((v_prop.payload->>'starts_at')::timestamptz,host.starts_at) else host.starts_at end);
      combined_end:=greatest(host.ends_at,case when v_explicit then coalesce((v_prop.payload->>'ends_at')::timestamptz,host.ends_at) else host.ends_at end);
      if route_before ? host.id::text then
        combined_start:=least(combined_start,(route_before->host.id::text->>'new_starts_at')::timestamptz);
        combined_end:=greatest(combined_end,(route_before->host.id::text->>'new_ends_at')::timestamptz);
      end if;
      if combined_end>host.ends_at or combined_start<host.starts_at then
        gap_override:=host.turnaround_override_minutes;
        if v_prop.created_via='sadran' and v_explicit and coalesce((v_prop.payload->>'allow_tight_turnaround')::boolean,false) then
          gap_override:=public.prepare_manual_ride_window(host.car_id,host.week_start,combined_start,combined_end,host.id);
        end if;
        update public.rides set starts_at=combined_start,ends_at=combined_end,turnaround_override_minutes=gap_override where id=host.id;
      end if;
      perform public.assert_ride_request_day(host.id);
      perform public.assert_ride_seats_fit(host.id);
      perform public.assert_car_chain(host.car_id,host.week_start);
    end loop;
    update public.requests set status = (case when exists(select 1 from public.ride_requests rr join public.rides r on r.id=rr.ride_id where rr.request_id=v_req.id and r.needs_driver and r.status<>'cancelled') then 'waitlisted' when v_has_driver_leg then 'assigned' else 'merged' end)::public.request_status,
      status_reason = case when exists(select 1 from public.ride_requests rr join public.rides r on r.id=rr.ride_id where rr.request_id=v_req.id and r.needs_driver and r.status<>'cancelled') then 'UNMET_NEEDS_DRIVER' else 'PROPOSAL_APPLIED' end
    where id = v_prop.request_id;
  end if;

  perform set_config('app.system_status_transition', 'off', true);
  perform set_config('app.applying_proposal', '', true);

  update public.proposals set status = 'applied', applied_at = now(), applied_ride_id = v_ride_id where id = p_proposal_id;

  select full_name into v_byname from public.profiles where id = v_prop.created_by;
  if v_prop.type = 'merge' then
    -- The joiner: where they ride now, with whom, at what time.
    perform public.enqueue_notification(v_req.requester_id, 'outcome_changed', v_prop.department_id, v_prop.week_start,
      coalesce(v_rv_joiner->'vars', '{}'::jsonb),
      jsonb_build_object('request_id', v_prop.request_id, 'variant',
        case v_rv_joiner->>'variant' when 'merge_passenger_split' then 'merged_split'
          when 'merge_passenger_no_driver' then 'merged_no_driver' else 'merged' end),
      format('outcome_changed:%s:%s', v_prop.request_id, p_proposal_id));
    -- Everyone else on the ride(s): who joined, and only what changes for them.
    for v_rcpt in select key as pid, value as rv from jsonb_each(v_rvs) loop
      perform public.enqueue_notification(v_rcpt.pid::uuid, 'outcome_changed', v_prop.department_id, v_prop.week_start,
        (v_rcpt.rv->'vars'),
        jsonb_build_object('ride_id', v_ride_id, 'variant', 'joined_ride'),
        format('merge_applied:%s:%s', v_prop.id, v_rcpt.pid));
    end loop;
  else
    v_variant := null; v_vars := '{}'::jsonb;
    if v_prop.type = 'external' then
      -- REQ §13.102 R2M5: accepting "arrange it yourself" has its own notice, not the generic "your siddur changed".
      v_variant := 'external_accepted';
      v_vars := jsonb_build_object('route', coalesce(public.request_route_label(v_req.id), ''),
        'day', public.day_date_label(coalesce(v_old_dep, v_old_ret)));
    end if;
    if v_prop.type = 'deny' then
      -- R20B16 (owner 2026-11-14): accepting "no car" has its own notice, like "arrange it yourself".
      v_variant := 'deny_accepted';
      v_vars := jsonb_build_object('route', coalesce(public.request_route_label(v_req.id), ''),
        'day', public.day_date_label(coalesce(v_old_dep, v_old_ret)));
    end if;
    if v_prop.type = 'alternative' then
      v_variant := 'alternative_applied';
      v_vars := jsonb_build_object('route', coalesce(public.request_route_label(v_req.id), ''),
        'day', public.day_date_label(coalesce(v_old_dep, v_old_ret))) || public._alternative_vars(v_prop.payload, v_prop.department_id);
    end if;
    if v_prop.type = 'shift' then
      select c.name into v_new_car from public.cars c where c.id = nullif(v_prop.payload->>'car_id', '')::uuid;
      select c.name into v_old_car_name from public.cars c where c.id = v_old_car;
      if v_prop.payload ? 'series_span' then
        v_tc := public._time_change_line(v_old_series_dep, v_old_series_ret,
          (v_prop.payload->'series_span'->>'depart_at')::timestamptz, (v_prop.payload->'series_span'->>'return_at')::timestamptz, true);
      else
        v_tc := public._time_change_line(v_old_dep, v_old_ret,
          nullif(v_prop.payload->>'depart_at', '')::timestamptz, nullif(v_prop.payload->>'return_at', '')::timestamptz);
      end if;
      if v_old_car is not null and v_new_car is not null and v_old_car is distinct from nullif(v_prop.payload->>'car_id', '')::uuid then
        v_change_line := public._frag('change.car', jsonb_build_object('newCar', v_new_car, 'oldCar', v_old_car_name));
      end if;
      if v_tc <> '' then
        v_variant := 'time_changed';
        v_vars := jsonb_build_object('byName', coalesce(v_byname, ''), 'route', coalesce(public.request_route_label(v_req.id), ''),
          'day', public.day_date_label(coalesce(v_old_dep, v_old_ret)), 'timeChange', v_tc,
          'carLine', case when coalesce(v_new_car, '') <> '' then ' · ' || v_new_car else '' end);
      elsif v_change_line <> '' then
        v_variant := 'car_changed';
        v_vars := jsonb_build_object('route', coalesce(public.request_route_label(v_req.id), ''),
          'day', public.day_date_label(coalesce(v_old_dep, v_old_ret)), 'changeLine', v_change_line);
      end if;
    end if;
    perform public.enqueue_notification(v_req.requester_id, 'outcome_changed', v_prop.department_id, v_prop.week_start,
      v_vars, jsonb_build_object('request_id', v_prop.request_id) || case when v_variant is null then '{}'::jsonb else jsonb_build_object('variant', v_variant) end,
      format('outcome_changed:%s:%s', v_prop.request_id, p_proposal_id));
  end if;
  return v_ride_id;
end;
$$;
