-- WT1 (owner 2026-11-15; REQ item 243): the waiting list and freed cars treat the turnaround as a warning. A waiting
-- request takes a freed car also when it starts less than the turnaround after the ride before, or ends less than it
-- before the car's next ride — there is nobody to ask, so it is placed and told:
--   * the placed member's "שובצת לרכב שהתפנה" notice ends with "חשוב לוודא עם X שנוסע/ת לפניך כי הסידור צפוף."
--     (`{{tightNote}}`, fragment `freed_tight.before`; nothing when the ride before is their own or not close);
--   * the driver right before gets `short_turnaround_before`, the driver right after `short_turnaround` (item 242 / 190),
--     unless it is the same person.
-- The ranking (solver `freedSlotRun.ts`) fits candidates into the gap with no turnaround; the probe and the placement
-- here (`place_freed_slot_request`) accept it; `freed_slot_candidates` rules a candidate out only on a real overlap.

insert into public.text_fragments (key, body) values
  ('freed_tight.before', 'חשוב לוודא עם {{name}} שנוסע/ת לפניך כי הסידור צפוף.')
on conflict (key) do nothing;

update public.notification_templates
   -- an admin-edited body is left alone; the seeded text (also where default_body was never kept in step) moves
   set body = case when body = default_body or body = '{{car}}, יום {{day}} {{timeRange}} {{route}}.'
                   then '{{car}}, יום {{day}} {{timeRange}} {{route}}.{{tightNote}}' else body end,
       default_body = '{{car}}, יום {{day}} {{timeRange}} {{route}}.{{tightNote}}'
 where event = 'freed_slot_auto' and variant is null;

-- " חשוב לוודא עם X שנוסע/ת לפניך כי הסידור צפוף." when the ride right before this one on its car ends less than the
-- turnaround before it and is someone else's; else ''.
create or replace function public._freed_tight_note(p_ride_id uuid)
returns text
language sql stable security definer
set search_path = public, pg_temp
as $$
  select coalesce((
    select ' ' || replace(f.body, '{{name}}', coalesce(v.info ->> 'name', ''))
    from public.rides r
    cross join lateral (select public._short_turnaround_before_info(r.car_id, r.starts_at, r.id) as info) v
    join public.text_fragments f on f.key = 'freed_tight.before'
    where r.id = p_ride_id and v.info is not null and (v.info ->> 'name') is not null
      and (v.info ->> 'recipient_id')::uuid is distinct from r.driver_id), '');
$$;
revoke execute on function public._freed_tight_note(uuid) from public, anon, authenticated;

-- place_freed_slot_request, resolve_freed_offer and freed_slot_candidates, each in full.

CREATE OR REPLACE FUNCTION "public"."place_freed_slot_request"("p_offer_id" "uuid", "p_request_id" "uuid", "p_actor" "uuid", "p_reason" "text") RETURNS "uuid"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
declare v_offer public.freed_slot_offers%rowtype; q public.requests%rowtype; v_ride uuid; v_covered text[]; v_prev text; v_supp text; v_claims text; v_gap smallint; v_new public.rides%rowtype;
begin
  select * into v_offer from public.freed_slot_offers where id = p_offer_id;
  select * into q from public.requests where id = p_request_id for update;
  if v_offer.id is null or q.id is null then raise exception 'offer_not_found' using errcode = 'P0001'; end if;
  v_prev := coalesce(current_setting('app.system_status_transition', true), 'off');
  -- REQ §13.168: a request served by its plan B takes the freed car with its main trip — the plan B (and its
  -- pickup sibling) is released first; the member hears only the outcome, not "your ride was cancelled",
  -- unless someone else rode on the plan-B ride.
  if q.served_by_alternative then
    v_supp := coalesce(current_setting('app.suppress_notifications', true), '');
    if not exists (select 1 from public.ride_requests rr join public.ride_requests other on other.ride_id = rr.ride_id and other.request_id <> rr.request_id
                   join public.rides r on r.id = rr.ride_id
                   where rr.request_id in (select q.id union select x.id from public.requests x where x.plan_b_parent_id = q.id) and r.status <> 'cancelled') then
      perform set_config('app.suppress_notifications', 'on', true);
    end if;
    -- with nobody signed in (the on-ride-cancelled edge function probing whether the car fits) the plan B is
    -- released on the member's behalf, so its cancelled rides carry a cancelled_by
    v_claims := current_setting('request.jwt.claims', true);
    if (select auth.uid()) is null then
      perform set_config('request.jwt.claims', jsonb_build_object('sub', q.requester_id, 'role', 'authenticated')::text, true);
    end if;
    perform public._restore_original_main(p_request_id);
    perform set_config('request.jwt.claims', coalesce(v_claims, ''), true);
    perform set_config('app.suppress_notifications', v_supp, true);
    select * into q from public.requests where id = p_request_id for update;
  end if;
  v_covered := public.request_covered_legs(p_request_id);
  perform set_config('app.system_status_transition', 'on', true);
  if q.trip_type = 'drop_off' then
    -- chauffeur legs on the freed car; legs a ride already serves are left alone (R2B3)
    perform set_config('app.place_only_missing', 'on', true);
    -- REQ §13.193: the probe and the automatic assignment run with no actor; the ride is then created by the
    -- requester, as for a round trip below (a null created_by made every הקפצה fail the probe)
    v_ride := public.place_request_on_car(p_request_id, v_offer.car_id, true, coalesce(p_actor, q.requester_id), null, null, null, p_reason);
    perform set_config('app.place_only_missing', 'off', true);
  elsif cardinality(v_covered) > 0 then
    raise exception 'freed_slot_not_applicable' using errcode = 'P0001';
  else
    -- WT1 (owner 2026-11-15, REQ item 243): a waiting request takes the freed car also inside a turnaround — the
    -- ride before gives up the rest of its turnaround, and this ride keeps only the gap to the car's next ride.
    update public.rides p
       set turnaround_override_minutes = greatest((extract(epoch from (q.depart_at - p.ends_at)) / 60)::int, 0)::smallint
     where p.car_id = v_offer.car_id and p.status <> 'cancelled' and not p.draft_hold
       and p.ends_at <= q.depart_at and p.blocked_until > q.depart_at;
    v_gap := (public._short_turnaround_info(v_offer.car_id, q.return_at, null) ->> 'gap')::smallint;
    insert into public.rides (department_id, week_start, car_id, starts_at, ends_at, origin_id, destination_id,
      driver_id, status, is_pinned, pin_reason, created_by, turnaround_override_minutes)
    select r.department_id, r.week_start, v_offer.car_id, q.depart_at, q.return_at, r.origin_id, r.destination_id,
      q.requester_id, 'confirmed', true, p_reason, coalesce(p_actor, q.requester_id), v_gap
    from public.rides r where r.id = v_offer.cancelled_ride_id
    returning id into v_ride;
    insert into public.ride_requests (ride_id, request_id, role, leg, car_mode)
    values (v_ride, p_request_id, 'driver', 'both', 'keep');
    perform public.assert_car_chain(v_offer.car_id, v_offer.week_start);
    update public.requests set status = 'assigned', status_reason = p_reason where id = p_request_id;
  end if;
  perform set_config('app.system_status_transition', v_prev, true);
  -- WT1: the drivers right before and right after (when they are someone else) are told the schedule is tight.
  if p_reason <> 'FREED_SLOT_PROBE' and q.trip_type <> 'drop_off' then
    select * into v_new from public.rides where id = v_ride;
    perform public._notify_short_turnaround_before(v_new.car_id, v_new.starts_at, v_new.id, q.requester_id);
    perform public._notify_short_turnaround(v_new.car_id, v_new.ends_at, v_new.id, q.requester_id);
  end if;
  return v_ride;
end $$;

CREATE OR REPLACE FUNCTION "public"."resolve_freed_offer"("p_offer_id" "uuid", "p_ranked_candidates" "jsonb", "p_options" "jsonb" DEFAULT '[]'::"jsonb") RETURNS "void"
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
      v_vars := jsonb_build_object('car', coalesce(v_cars, (select name from public.cars where id = v_offer.car_id), ''));
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
        'timeRange', to_char(v_offer.starts_at at time zone 'Asia/Jerusalem', 'HH24:MI') || '–' || to_char(v_offer.ends_at at time zone 'Asia/Jerusalem', 'HH24:MI')),
      jsonb_build_object('offer_id', p_offer_id, 'variant', 'options'), format('claim_contested:%s', p_offer_id))
    from public.sadranim_of(v_offer.department_id, v_offer.week_start) as s(profile_id);
  end if;
end;
$$;

CREATE OR REPLACE FUNCTION "public"."freed_slot_candidates"("_offer" "uuid") RETURNS TABLE("request_id" "uuid", "requester_id" "uuid", "fits" boolean, "slack" interval)
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
  with o as (
    select fo.*, cr.origin_id as cr_origin
    from freed_slot_offers fo join rides cr on cr.id = fo.cancelled_ride_id
    where fo.id = _offer and fo.status = 'open' and cr.origin_id = cr.destination_id
  ),
  pool as (
    -- the waiting list, as before (a plan B waiting for its driver is read with its main trip below)
    -- REQ §13.193: a one-leg הקפצה (drop-off only or pickup only) is read as its chauffeur ride at its own time
    select q.id, q.requester_id, q.adults, q.child_seats, q.boosters, q.has_luggage, q.needs_tow_hitch, q.luggage_waived_at,
      case when q.trip_type = 'drop_off' and q.depart_at is null
           then q.return_at - make_interval(mins => public.chauffeur_ride_minutes(q.id, 'return'))
           else q.depart_at end as dep,
      case when q.trip_type = 'drop_off' and q.return_at is null
           then q.depart_at + make_interval(mins => public.chauffeur_ride_minutes(q.id, 'out'))
           else q.return_at end as ret,
      q.origin_id, q.origin_text, q.submitted_at
    from o join requests q
      on q.department_id = o.department_id and q.week_start = o.week_start
     and q.status in ('waitlisted','denied','external') and not q.served_by_alternative
     and (q.trip_shape = 'round_trip' or q.trip_type = 'drop_off')   -- one-way requests are never auto-placed (REQ §13.64); a הקפצה is (§13.193)
     and q.series_id is null                             -- REQ §13.77: a multi-day series never fits a one-day freed slot
     -- R2B3: a request that already holds one leg is only a candidate for a הקפצה (the missing leg is placed alone)
     and (q.trip_type = 'drop_off' or cardinality(public.request_covered_legs(q.id)) = 0)
    where not q.freed_slot_opt_out
    union all
    -- REQ §13.168: served by its plan B; its main trip is a round trip
    select q.id, q.requester_id, q.adults, q.child_seats, q.boosters, q.has_luggage, q.needs_tow_hitch, q.luggage_waived_at,
      (a.original_main ->> 'depart_at')::timestamptz, (a.original_main ->> 'return_at')::timestamptz,
      q.origin_id, q.origin_text, q.submitted_at
    from o join requests q
      on q.department_id = o.department_id and q.week_start = o.week_start
     -- any live plan B: placed, riding with someone, or its chauffeur ride still waiting for a driver
     and q.status in ('assigned', 'merged', 'waitlisted') and q.served_by_alternative and q.series_id is null and q.plan_b_parent_id is null
    join request_alternatives a on a.request_id = q.id and a.original_main is not null
    where not q.freed_slot_opt_out and a.original_main ->> 'trip_type' = 'round_trip'
      and a.original_main ->> 'depart_at' is not null and a.original_main ->> 'return_at' is not null
  )
  select p.id, p.requester_id,
         public.car_fits(o.car_id, p.adults, p.child_seats, p.boosters) as fits,
         (o.ends_at - o.starts_at) - (p.ret - p.dep) as slack
  from o join pool p on true
  -- REQ §13.102 (b): the request's own times lie inside the car's free gap, and it starts where the car is
  where p.dep >= o.starts_at and p.ret <= o.ends_at
    and (p.origin_id = o.cr_origin or (p.origin_id is null and p.origin_text is null))
    and not exists (select 1 from rides r2 where r2.car_id = o.car_id and r2.status <> 'cancelled' and not r2.draft_hold
         and (o.kept_ride or r2.id <> o.cancelled_ride_id) and not r2.planning_conflict
         -- a plan-B request's own plan-B rides are released when it takes the car
         and not exists (select 1 from ride_requests rr where rr.ride_id = r2.id
                          and (rr.request_id = p.id or rr.request_id in (select x.id from requests x where x.plan_b_parent_id = p.id)))
         -- WT1 (REQ item 243): only a real overlap rules a candidate out — the turnaround is a warning
         and tstzrange(r2.starts_at, r2.ends_at, '[)') && tstzrange(p.dep, p.ret, '[)'))
    -- REQ §13.114: a scheduled maintenance period on the freed car (also one added after the offer was
    -- made) is never offered, incl. the turnaround buffer before it.
    and not exists (select 1 from car_maintenance_blocks b where b.car_id = o.car_id
         and tstzrange(b.starts_at, b.ends_at, '[)') && tstzrange(p.dep,
           p.ret + make_interval(mins => coalesce(public.required_turnaround_minutes(o.department_id, o.week_start), 30)), '[)'))
    -- RC1B3: the people a Sadran cancelled this ride on and kept on the waiting list are not offered its own car
    and p.id <> all(o.excluded_request_ids)
    and public.car_fits(o.car_id, p.adults, p.child_seats, p.boosters)
    and public.car_meets_needs(o.car_id, case when p.has_luggage and p.luggage_waived_at is null then 1 else 0 end, case when p.needs_tow_hitch and p.luggage_waived_at is null then 1 else 0 end)
  order by slack asc, p.submitted_at asc;
$$;
