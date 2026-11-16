-- R21U6 (owner triage 2026-11-16): the freed-car notices the Sadran decides carried no cause and quoted the car's whole
-- free gap ("00:00–18:30"); the "kept out of the app" message linked to a member request page. Now: the cause note in
-- their titles, the hours that matter (`_freed_offer_hours`), and the kept-out message opens the board on its day.
-- Full definitions of resolve_freed_offer, fail_freed_offer and notification_default_url.

-- The hours a freed-car notice quotes: the candidates' requested span inside the free gap; with no candidates the
-- freed ride's own hours inside it; else the gap. Never "00:00–18:30" for a car that was simply free since midnight.
create or replace function public._freed_offer_hours(p_offer_id uuid, p_request_ids uuid[])
returns text language sql stable security definer set search_path = public, pg_temp as $$
  with o as (select * from public.freed_slot_offers where id = p_offer_id),
  cand as (
    select min(coalesce(q.depart_at, q.return_at)) s, max(coalesce(q.return_at, q.depart_at)) e
    from public.requests q where q.id = any(coalesce(p_request_ids, '{}'))),
  ride as (select r.starts_at s, r.ends_at e from public.rides r join o on o.cancelled_ride_id = r.id),
  span as (
    select greatest(o.starts_at, coalesce(c.s, rd.s, o.starts_at)) s, least(o.ends_at, coalesce(c.e, rd.e, o.ends_at)) e,
           o.starts_at os, o.ends_at oe
    from o left join cand c on c.s is not null left join ride rd on true)
  select to_char(case when s < e then s else os end at time zone 'Asia/Jerusalem', 'HH24:MI') || '–'
      || to_char(case when s < e then e else oe end at time zone 'Asia/Jerusalem', 'HH24:MI')
  from span limit 1
$$;
revoke all on function public._freed_offer_hours(uuid, uuid[]) from public, anon, authenticated;

-- The cause in the titles of the notices the Sadran decides (member: "הסדרן/ית מחליט/ה"; Sadran: "options", "failed"),
-- like the automatic placement's. Only templates still at their seeded default text change.
update public.notification_templates set
  title = replace(title, 'התפנה רכב {{route}} — הסדרן/ית מחליט/ה', 'התפנה רכב {{route}}{{causeNote}} — הסדרן/ית מחליט/ה'),
  default_title = replace(default_title, 'התפנה רכב {{route}} — הסדרן/ית מחליט/ה', 'התפנה רכב {{route}}{{causeNote}} — הסדרן/ית מחליט/ה')
where event = 'freed_slot' and variant = 'sadran_deciding' and title = default_title;
update public.notification_templates set
  title = 'רכב התפנה{{causeNote}} — אין בחירה אחת ברורה', default_title = 'רכב התפנה{{causeNote}} — אין בחירה אחת ברורה'
where event = 'claim_contested' and variant = 'options' and title = default_title;
update public.notification_templates set
  title = 'רכב שהתפנה לא נמסר{{causeNote}} — דרושה בדיקה', default_title = 'רכב שהתפנה לא נמסר{{causeNote}} — דרושה בדיקה'
where event = 'claim_contested' and variant = 'freed_failed' and title = default_title;

create or replace function public.resolve_freed_offer("p_offer_id" "uuid", "p_ranked_candidates" "jsonb", "p_options" "jsonb" DEFAULT '[]'::"jsonb") RETURNS "void"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
declare
  v_offer record;
  v_count int;
  v_first jsonb;
  v_ride_id uuid;
  v_cand jsonb;
  v_req uuid; v_to uuid; v_cars text; v_main jsonb; v_q public.requests%rowtype; v_vars jsonb; v_notif uuid;
  v_group uuid; v_g record; m record; v_car_name text;
  v_prio uuid[]; v_ok jsonb := '[]'::jsonb; v_ok_ids uuid[]; v_plan_b int; v_options jsonb; v_rec text;
  v_cause text := public._freed_cause_note(p_offer_id); v_ride public.rides%rowtype; v_person uuid;
begin
  select * into v_offer from public.freed_slot_offers where id = p_offer_id;
  if v_offer is null then raise exception 'offer_not_found' using errcode = 'P0001'; end if;
  if v_offer.status <> 'open' then raise exception 'offer_not_open' using errcode = 'P0001'; end if;

  -- R12B3 (REQ §13.119): a candidate the freed car cannot really take (the car is not at the leg's place, a turnaround...)
  -- is dropped here, so the lone-candidate placement below cannot fail with car_not_at_leg_place.
  for v_cand in select * from jsonb_array_elements(coalesce(p_ranked_candidates, '[]')) loop
    -- R17B5: someone who stepped out of this car stays out when it is ranked again (a group closing, a refresh).
    if not exists (select 1 from public.freed_slot_claims x where x.offer_id = p_offer_id
                   and x.request_id = (v_cand ->> 'request_id')::uuid and x.status = 'withdrawn')
       and public.freed_candidate_placeable(p_offer_id, (v_cand ->> 'request_id')::uuid) then v_ok := v_ok || jsonb_build_array(v_cand); end if;
  end loop;
  p_ranked_candidates := v_ok;
  v_count := jsonb_array_length(p_ranked_candidates);
  -- REQ §13.168: the options (one request, or several one after another) keep only placeable candidates.
  select coalesce(array_agg((c ->> 'request_id')::uuid), '{}') into v_ok_ids from jsonb_array_elements(p_ranked_candidates) c;
  -- the best remaining option is the recommendation (the edge function's first one may have been dropped)
  select coalesce(jsonb_agg(o || jsonb_build_object('recommended', rn = 1) order by rn), '[]'::jsonb) into v_options
  from (select o, row_number() over (order by n) as rn
        from jsonb_array_elements(coalesce(p_options, '[]'::jsonb)) with ordinality x(o, n)
        where not exists (select 1 from jsonb_array_elements_text(o -> 'request_ids') rid where rid::uuid <> all(v_ok_ids))) kept;
  select count(*) into v_plan_b from public.requests q where q.id = any(v_ok_ids) and q.served_by_alternative;
  perform set_config('app.audit_reason', 'resolve_freed_offer', true);

  -- REQ §13.101 (i): the open contested group whose time this car frees goes first.
  v_group := public.freed_offer_group(p_offer_id);
  if v_group is not null and v_count > 0 then
    select coalesce(array_agg(wm.request_id), '{}') into v_prio from public.waitlist_group_members wm
    where wm.group_id = v_group and wm.chosen is null
      and wm.request_id in (select (c ->> 'request_id')::uuid from jsonb_array_elements(p_ranked_candidates) c);
    if cardinality(v_prio) > 0 then
      select * into v_g from public.waitlist_groups where id = v_group;
      select name into v_car_name from public.cars where id = v_offer.car_id;
      update public.freed_slot_offers set group_id = v_group where id = p_offer_id;
      for m in select wm.request_id, wm.profile_id from public.waitlist_group_members wm
               where wm.group_id = v_group and wm.chosen is null order by wm.created_at, wm.id loop
        perform public.enqueue_notification(m.profile_id, 'waitlist_contested', v_g.department_id, v_g.week_start,
          jsonb_build_object('car', coalesce(v_car_name, ''), 'day', public.day_date_label(v_g.starts_at),
            'depart', to_char(v_g.starts_at at time zone 'Asia/Jerusalem', 'HH24:MI'),
            'return', to_char(v_g.ends_at at time zone 'Asia/Jerusalem', 'HH24:MI'), 'causeNote', v_cause, 'tightNote', ''),
          jsonb_build_object('group_id', v_group, 'request_id', m.request_id, 'day', v_g.day::text, 'variant', 'car_freed'),
          format('waitlist_car_freed:%s:%s:%s', v_group, p_offer_id, m.profile_id));
      end loop;
      perform public.enqueue_notification(s.profile_id, 'waitlist_contested', v_g.department_id, v_g.week_start,
        jsonb_build_object('car', coalesce(v_car_name, ''), 'day', public.day_date_label(v_g.starts_at),
          'depart', to_char(v_g.starts_at at time zone 'Asia/Jerusalem', 'HH24:MI'),
          'return', to_char(v_g.ends_at at time zone 'Asia/Jerusalem', 'HH24:MI'), 'causeNote', v_cause, 'tightNote', ''),
        jsonb_build_object('group_id', v_group, 'day', v_g.day::text, 'variant', 'car_freed_sadran'),
        format('waitlist_car_freed:%s:%s:sadran:%s', v_group, p_offer_id, s.profile_id))
      from public.sadranim_of(v_g.department_id, v_g.week_start) as s(profile_id);
      return;
    end if;
  end if;

  if v_count = 0 then
    update public.freed_slot_offers set status = 'closed', resolved_at = now() where id = p_offer_id;
  elsif v_count = 1 and v_plan_b = 0 then
    -- REQ §13.168 (b): obvious — one waiting-list candidate (a lone plan-B candidate still goes to the Sadran:
    -- it trades a plan B that works).
    v_first := p_ranked_candidates -> 0;
    begin
      v_ride_id := public.place_freed_slot_request(p_offer_id, (v_first ->> 'request_id')::uuid, null, 'FREED_SLOT_AUTO');
    exception when others then
      -- never silently stuck: close the offer with the reason and tell the Sadran
      perform public.fail_freed_offer(p_offer_id, sqlerrm);
      return;
    end;

    update public.freed_slot_offers set status = 'auto_assigned', resolved_at = now(),
      winning_request_id = (v_first ->> 'request_id')::uuid
    where id = p_offer_id;

    -- FC1: the car, day, hours and route of the new ride, and the cause, to everyone on it — one notice each.
    select * into v_ride from public.rides where id = v_ride_id;
    v_vars := jsonb_build_object(
      'car', coalesce((select name from public.cars where id = v_offer.car_id), ''),
      'day', coalesce(public.day_date_label(v_ride.starts_at), ''),
      'timeRange', coalesce(public._window_text(v_ride.starts_at, v_ride.ends_at), ''),
      'route', coalesce(public.request_route_label((v_first ->> 'request_id')::uuid), ''),
      'causeNote', v_cause, 'tightNote', public._freed_tight_note(v_ride_id));
    for v_person in
      select x.pid from (
        select (v_first ->> 'requester_id')::uuid as pid
        union select v_ride.driver_id
        union select q.requester_id from public.ride_requests rr join public.requests q on q.id = rr.request_id where rr.ride_id = v_ride_id
        union select rc.profile_id from public.ride_requests rr join public.request_companions rc on rc.request_id = rr.request_id
              where rr.ride_id = v_ride_id
        union select rp.person_id from public.ride_passengers rp where rp.ride_id = v_ride_id) x
      where x.pid is not null order by x.pid
    loop
      perform public.enqueue_notification(v_person, 'freed_slot_auto', v_offer.department_id, v_offer.week_start,
        v_vars, jsonb_build_object('ride_id', v_ride_id, 'request_id', (v_first ->> 'request_id')::uuid),
        format('freed_slot_auto:%s:%s', p_offer_id, v_person));
    end loop;
  else
    for v_cand in select * from jsonb_array_elements(p_ranked_candidates) loop
      v_req := (v_cand ->> 'request_id')::uuid;
      v_to := (v_cand ->> 'requester_id')::uuid;
      -- ranked again (R17B5): a candidate already told about this car is not told again
      continue when exists (select 1 from public.freed_slot_claims x where x.offer_id = p_offer_id and x.request_id = v_req);
      insert into public.freed_slot_claims (offer_id, request_id, profile_id, status, offered_at)
      values (p_offer_id, v_req, v_to, 'offered', now());
      -- R17B4 (QA run 17): one notice per request, not one per freed car — an unread "the Sadran decides" notice of
      -- the same request is folded into this one, which names every car still being decided for it.
      select string_agg(distinct c.name, ' / ') into v_cars
      from public.freed_slot_claims fc join public.freed_slot_offers o on o.id = fc.offer_id join public.cars c on c.id = o.car_id
      where fc.request_id = v_req and fc.status = 'offered' and (o.id = p_offer_id or o.status in ('open', 'pending_approval'));
      delete from public.notifications
      where recipient_id = v_to and event = 'freed_slot' and read_at is null
        and data ->> 'request_id' = v_req::text and data ->> 'variant' = 'sadran_deciding';
      -- R17B3: a request served by its plan B reads its main trip (route, day, hours), not the plan B's.
      select a.original_main into v_main from public.request_alternatives a
      where a.request_id = v_req and a.applied_at is not null and a.original_main is not null;
      select * into v_q from public.requests where id = v_req;
      v_vars := jsonb_build_object('car', coalesce(v_cars, (select name from public.cars where id = v_offer.car_id), ''), 'causeNote', v_cause);
      if v_main is not null and v_q.served_by_alternative then
        v_vars := v_vars || jsonb_build_object(
          'route', coalesce(public.route_label(v_q.department_id, v_q.origin_id, v_q.origin_text,
            nullif(v_main ->> 'destination_id', '')::uuid, v_main ->> 'destination_text'), ''),
          'day', public.day_date_label((v_main ->> 'depart_at')::timestamptz),
          'timeRange', public._window_text((v_main ->> 'depart_at')::timestamptz, nullif(v_main ->> 'return_at', '')::timestamptz));
      end if;
      v_notif := public.enqueue_notification(v_to, 'freed_slot', v_offer.department_id, v_offer.week_start, v_vars,
        jsonb_build_object('offer_id', p_offer_id, 'request_id', v_req, 'variant', 'sadran_deciding'),
        format('freed_slot:%s:%s:%s', p_offer_id, v_req, clock_timestamp()));
      if v_notif is not null then
        update public.push_outbox set payload = payload || jsonb_build_object('tag', format('replace:freed_slot:%s', v_req))
        where notification_id = v_notif;
      end if;
    end loop;
    -- REQ §13.168 (c): no single obvious choice — the Sadran decides from the ranked options.
    if jsonb_array_length(v_options) = 0 then
      select coalesce(jsonb_agg(jsonb_build_object('request_ids', jsonb_build_array(c ->> 'request_id'), 'score', 0,
        'unused_minutes', 0, 'plan_b', 0, 'recommended', n = 1) order by n), '[]'::jsonb)
      into v_options from jsonb_array_elements(p_ranked_candidates) with ordinality x(c, n);
    end if;
    select string_agg(coalesce(p.full_name, ''), ' + ' order by rid.n) into v_rec
    from jsonb_array_elements_text((select o -> 'request_ids' from jsonb_array_elements(v_options) o where (o ->> 'recommended')::boolean limit 1)) with ordinality rid(id, n)
    join public.requests q on q.id = rid.id::uuid join public.profiles p on p.id = q.requester_id;
    update public.freed_slot_offers set status = 'pending_approval', options = v_options where id = p_offer_id;
    perform public.enqueue_notification(s.profile_id, 'claim_contested', v_offer.department_id, v_offer.week_start,
      jsonb_build_object('count', jsonb_array_length(v_options)::text, 'recommended', coalesce(v_rec, ''),
        'car', coalesce((select name from public.cars where id = v_offer.car_id), ''),
        'day', public.day_date_label(v_offer.starts_at),
        -- R21U6: the hours that matter (the candidates' span, else the freed ride's), not the car's whole free gap
        'timeRange', public._freed_offer_hours(p_offer_id, array(select (c ->> 'request_id')::uuid from jsonb_array_elements(p_ranked_candidates) c)),
        'causeNote', v_cause),
      jsonb_build_object('offer_id', p_offer_id, 'variant', 'options'), format('claim_contested:%s', p_offer_id))
    from public.sadranim_of(v_offer.department_id, v_offer.week_start) as s(profile_id);
  end if;
end;
$$;

create or replace function public.fail_freed_offer("p_offer_id" "uuid", "p_reason" "text") RETURNS "void"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
declare v_offer public.freed_slot_offers%rowtype; v_car text;
begin
  select * into v_offer from public.freed_slot_offers where id = p_offer_id for update;
  if v_offer.id is null or v_offer.status not in ('open', 'pending_approval') then return; end if;
  update public.freed_slot_offers set status = 'closed', resolved_at = now(), close_reason = left(coalesce(p_reason, 'unknown'), 200)
  where id = p_offer_id;
  select name into v_car from public.cars where id = v_offer.car_id;
  perform public.enqueue_notification(s.profile_id, 'claim_contested', v_offer.department_id, v_offer.week_start,
    jsonb_build_object('car', coalesce(v_car, ''), 'day', public.day_date_label(v_offer.starts_at),
      'timeRange', public._freed_offer_hours(p_offer_id, '{}'), 'causeNote', public._freed_cause_note(p_offer_id)),
    jsonb_build_object('offer_id', p_offer_id, 'variant', 'freed_failed'), format('freed_failed:%s', p_offer_id))
  from public.sadranim_of(v_offer.department_id, v_offer.week_start) as s(profile_id);
end $$;

create or replace function public.notification_default_url("_event" "public"."notification_event", "_data" "jsonb", "_department_id" "uuid", "_week_start" "date", "_recipient" "uuid" DEFAULT NULL::"uuid") RETURNS "text"
    LANGUAGE "plpgsql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
declare
  v_token text := nullif(_data ->> 'token', '');
  v_proposal_id uuid := nullif(_data ->> 'proposal_id', '')::uuid;
  v_ride_change_id uuid := nullif(_data ->> 'ride_change_id', '')::uuid;
  v_request_id uuid := coalesce(nullif(_data ->> 'request_id', '')::uuid, nullif(_data ->> 'offer_id', '')::uuid);
  v_ride_id uuid := nullif(_data ->> 'ride_id', '')::uuid;
  v_car_id uuid := nullif(_data ->> 'car_id', '')::uuid;
  v_group_id uuid := nullif(_data ->> 'group_id', '')::uuid;
  v_day text := nullif(_data ->> 'day', '');
  v_week_scoped boolean;
  v_sadran_role boolean;
  v_is_sadran_event boolean;
  v_manager boolean;
begin
  -- R5B4: the Sadran proposals page is for the people who manage the week; everyone else falls through to their own links.
  v_manager := _recipient is null
    or exists (select 1 from public.sadranim_of(_department_id, _week_start) s where s = _recipient)
    or exists (select 1 from public.department_members dm where dm.department_id = _department_id and dm.profile_id = _recipient
               and dm.role = 'sadran' and dm.removed_at is null)
    or exists (select 1 from public.profiles p where p.id = _recipient and p.is_admin);

  if v_token is not null then
    return '/p/' || v_token;
  end if;

  if v_proposal_id is not null and v_manager and _department_id is not null and _week_start is not null then
    return format('/sadran/%s/%s/proposals?proposal=%s', _department_id, _week_start, v_proposal_id);
  end if;

  if v_group_id is not null and v_day is not null and _department_id is not null and _week_start is not null then
    return format('/siddur/%s/%s?day=%s&group=%s', _department_id, _week_start, v_day, v_group_id);
  end if;

  -- R21U6 (owner 2026-11-16): "a freed car kept out of the app" opens the board on that day, not a request page
  if _data ->> 'variant' = 'freed_kept_out' and v_manager and _department_id is not null and _week_start is not null then
    return format('/sadran/%s/%s/board?day=%s', _department_id, _week_start,
      coalesce((select to_char(o.starts_at at time zone 'Asia/Jerusalem', 'YYYY-MM-DD') from public.freed_slot_offers o
                where o.id = nullif(_data ->> 'offer_id', '')::uuid),
               (select to_char(r.starts_at at time zone 'Asia/Jerusalem', 'YYYY-MM-DD') from public.rides r where r.id = v_ride_id), ''));
  end if;

  if v_ride_change_id is not null then
    return format('/inbox?change=%s', v_ride_change_id);
  end if;

  -- R15U13 (QA run 15): a week manager's own Sadran notices open the Sadran screens, not the member's /requests page:
  -- a contested freed car its claims page, a late / changed / waitlisted / auto-approved request the board on its day.
  select week_scoped, sadran_role into v_week_scoped, v_sadran_role
  from public.notification_event_meta where event = _event;
  if v_manager and coalesce(v_sadran_role, false) and _department_id is not null and _week_start is not null then
    if _data ? 'offer_id' then
      return format('/sadran/%s/%s/claims/%s', _department_id, _week_start, _data ->> 'offer_id');
    end if;
    if nullif(_data ->> 'request_id', '') is not null then
      return format('/sadran/%s/%s/board?day=%s', _department_id, _week_start,
        coalesce((select to_char(coalesce(q.depart_at, q.return_at) at time zone 'Asia/Jerusalem', 'YYYY-MM-DD')
                  from public.requests q where q.id = (_data ->> 'request_id')::uuid), ''));
    end if;
  end if;

  if v_request_id is not null then
    return format('/requests?focus=%s', v_request_id);
  end if;

  if v_ride_id is not null and _department_id is not null and _week_start is not null then
    return format('/siddur/%s/%s?ride=%s', _department_id, _week_start, v_ride_id);
  end if;

  if v_car_id is not null then
    return format('/cars/%s', v_car_id);
  end if;

  select week_scoped, sadran_role into v_week_scoped, v_sadran_role
  from public.notification_event_meta where event = _event;

  if _department_id is not null and _week_start is not null and coalesce(v_week_scoped, false) then
    v_is_sadran_event := coalesce(v_sadran_role, false)
      and (_event <> 'window_open' or _data ->> 'variant' = 'sadran');
    if v_is_sadran_event then
      return format('/sadran/%s/%s', _department_id, _week_start);
    end if;
    return format('/siddur/%s/%s', _department_id, _week_start);
  end if;

  return '/inbox';
end;
$$;
