-- REQ §13.168 fixes found by running the QA scenario through the real on-ride-cancelled edge function:
-- (1) a request served by its plan B is a freed-car candidate whatever state that plan B is in — placed, riding with
--     someone, or its chauffeur ride still waiting for a driver ('waitlisted', UNMET_NEEDS_DRIVER) — read with its main trip;
-- (2) the edge function probes placement as the service role (no auth.uid()): releasing a plan B then needs an actor for
--     the cancelled rides — the member's own;
-- (3) when options are dropped as unplaceable, the best remaining one becomes the recommendation;
-- (4) awarding a combination approves several claims of one offer: the one-approved-claim index goes;
-- (5) a request that gets a car (placed or merged, any path) leaves every other freed-car offer it is a candidate on,
--     and award / discussion refuse a candidate that already has a car.

drop index if exists public.freed_slot_claims_one_approved_idx;

create or replace function public.freed_slot_candidates(_offer uuid)
returns table(request_id uuid, requester_id uuid, fits boolean, slack interval)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  with o as (
    select fo.*, cr.origin_id as cr_origin
    from freed_slot_offers fo join rides cr on cr.id = fo.cancelled_ride_id
    where fo.id = _offer and fo.status = 'open' and cr.origin_id = cr.destination_id
  ),
  pool as (
    -- the waiting list, as before (a plan B waiting for its driver is read with its main trip below)
    select q.id, q.requester_id, q.adults, q.child_seats, q.boosters, q.has_luggage, q.luggage_waived_at,
      q.depart_at as dep, q.return_at as ret, q.origin_id, q.origin_text, q.submitted_at
    from o join requests q
      on q.department_id = o.department_id and q.week_start = o.week_start
     and q.status in ('waitlisted','denied','external') and not q.served_by_alternative
     and q.trip_shape = 'round_trip'                     -- one-way requests are never auto-placed (REQ §13.64)
     and q.series_id is null                             -- REQ §13.77: a multi-day series never fits a one-day freed slot
     -- R2B3: a request that already holds one leg is only a candidate for a הקפצה (the missing leg is placed alone)
     and (q.trip_type = 'drop_off' or cardinality(public.request_covered_legs(q.id)) = 0)
    where not q.freed_slot_opt_out
    union all
    -- REQ §13.168: served by its plan B; its main trip is a round trip
    select q.id, q.requester_id, q.adults, q.child_seats, q.boosters, q.has_luggage, q.luggage_waived_at,
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
         and r2.id <> o.cancelled_ride_id and not r2.planning_conflict
         -- a plan-B request's own plan-B rides are released when it takes the car
         and not exists (select 1 from ride_requests rr where rr.ride_id = r2.id
                          and (rr.request_id = p.id or rr.request_id in (select x.id from requests x where x.plan_b_parent_id = p.id)))
         and tstzrange(r2.starts_at, r2.blocked_until, '[)') && tstzrange(p.dep, p.ret, '[)'))
    -- REQ §13.114: a scheduled maintenance period on the freed car (also one added after the offer was
    -- made) is never offered, incl. the turnaround buffer before it.
    and not exists (select 1 from car_maintenance_blocks b where b.car_id = o.car_id
         and tstzrange(b.starts_at, b.ends_at, '[)') && tstzrange(p.dep,
           p.ret + make_interval(mins => coalesce(public.required_turnaround_minutes(o.department_id, o.week_start), 30)), '[)'))
    -- RC1B3: the people a Sadran cancelled this ride on and kept on the waiting list are not offered its own car
    and p.id <> all(o.excluded_request_ids)
    and public.car_fits(o.car_id, p.adults, p.child_seats, p.boosters)
    and public.car_takes_luggage(o.car_id, case when p.has_luggage and p.luggage_waived_at is null then 1 else 0 end)
  order by slack asc, p.submitted_at asc;
$$;


create or replace function public.place_freed_slot_request("p_offer_id" "uuid", "p_request_id" "uuid", "p_actor" "uuid", "p_reason" "text") RETURNS "uuid"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
declare v_offer public.freed_slot_offers%rowtype; q public.requests%rowtype; v_ride uuid; v_covered text[]; v_prev text; v_supp text; v_claims text;
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
    v_ride := public.place_request_on_car(p_request_id, v_offer.car_id, true, p_actor, null, null, null, p_reason);
    perform set_config('app.place_only_missing', 'off', true);
  elsif cardinality(v_covered) > 0 then
    raise exception 'freed_slot_not_applicable' using errcode = 'P0001';
  else
    insert into public.rides (department_id, week_start, car_id, starts_at, ends_at, origin_id, destination_id,
      driver_id, status, is_pinned, pin_reason, created_by)
    select r.department_id, r.week_start, v_offer.car_id, q.depart_at, q.return_at, r.origin_id, r.destination_id,
      q.requester_id, 'confirmed', true, p_reason, coalesce(p_actor, q.requester_id)
    from public.rides r where r.id = v_offer.cancelled_ride_id
    returning id into v_ride;
    insert into public.ride_requests (ride_id, request_id, role, leg, car_mode)
    values (v_ride, p_request_id, 'driver', 'both', 'keep');
    perform public.assert_car_chain(v_offer.car_id, v_offer.week_start);
    update public.requests set status = 'assigned', status_reason = p_reason where id = p_request_id;
  end if;
  perform set_config('app.system_status_transition', v_prev, true);
  return v_ride;
end $$;

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
  v_group uuid; v_g record; m record; v_car_name text;
  v_prio uuid[]; v_ok jsonb := '[]'::jsonb; v_ok_ids uuid[]; v_plan_b int; v_options jsonb; v_rec text;
begin
  select * into v_offer from public.freed_slot_offers where id = p_offer_id;
  if v_offer is null then raise exception 'offer_not_found' using errcode = 'P0001'; end if;
  if v_offer.status <> 'open' then raise exception 'offer_not_open' using errcode = 'P0001'; end if;

  -- R12B3 (REQ §13.119): a candidate the freed car cannot really take (the car is not at the leg's place, a turnaround...)
  -- is dropped here, so the lone-candidate placement below cannot fail with car_not_at_leg_place.
  for v_cand in select * from jsonb_array_elements(coalesce(p_ranked_candidates, '[]')) loop
    if public.freed_candidate_placeable(p_offer_id, (v_cand ->> 'request_id')::uuid) then v_ok := v_ok || jsonb_build_array(v_cand); end if;
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
            'return', to_char(v_g.ends_at at time zone 'Asia/Jerusalem', 'HH24:MI')),
          jsonb_build_object('group_id', v_group, 'request_id', m.request_id, 'day', v_g.day::text, 'variant', 'car_freed'),
          format('waitlist_car_freed:%s:%s:%s', v_group, p_offer_id, m.profile_id));
      end loop;
      perform public.enqueue_notification(s.profile_id, 'waitlist_contested', v_g.department_id, v_g.week_start,
        jsonb_build_object('car', coalesce(v_car_name, ''), 'day', public.day_date_label(v_g.starts_at),
          'depart', to_char(v_g.starts_at at time zone 'Asia/Jerusalem', 'HH24:MI'),
          'return', to_char(v_g.ends_at at time zone 'Asia/Jerusalem', 'HH24:MI')),
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

    perform public.enqueue_notification((v_first ->> 'requester_id')::uuid, 'freed_slot_auto', v_offer.department_id, v_offer.week_start,
      '{}'::jsonb, jsonb_build_object('ride_id', v_ride_id, 'request_id', (v_first ->> 'request_id')::uuid), format('freed_slot_auto:%s', p_offer_id));
  else
    for v_cand in select * from jsonb_array_elements(p_ranked_candidates) loop
      insert into public.freed_slot_claims (offer_id, request_id, profile_id, status, offered_at)
      values (p_offer_id, (v_cand ->> 'request_id')::uuid, (v_cand ->> 'requester_id')::uuid, 'offered', now())
      on conflict (offer_id, request_id) do nothing;
      -- R15B6: the car is named explicitly (the day and times come from the member's own request).
      perform public.enqueue_notification((v_cand ->> 'requester_id')::uuid, 'freed_slot', v_offer.department_id, v_offer.week_start,
        jsonb_build_object('car', coalesce((select name from public.cars where id = v_offer.car_id), '')),
        jsonb_build_object('offer_id', p_offer_id, 'request_id', (v_cand ->> 'request_id')::uuid, 'variant', 'sadran_deciding'),
        format('freed_slot:%s:%s', p_offer_id, v_cand ->> 'request_id'));
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

create or replace function public.award_freed_option(p_offer_id uuid, p_request_ids uuid[])
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare v_offer public.freed_slot_offers%rowtype; v_actor uuid := (select auth.uid()); r record; v_ride uuid;
  v_rides jsonb := '[]'::jsonb; v_first uuid; v_sorted uuid[]; v_now timestamptz := now();
begin
  select * into v_offer from public.freed_slot_offers where id = p_offer_id for update;
  if v_offer.id is null then raise exception 'offer_not_found' using errcode = 'P0001'; end if;
  if not public.can_manage_week(v_offer.department_id, v_offer.week_start) then raise exception 'not_authorized' using errcode = 'P0001'; end if;
  if v_offer.status <> 'pending_approval' then raise exception 'offer_not_open' using errcode = 'P0001'; end if;
  select array_agg(x order by x) into v_sorted from (select distinct unnest(p_request_ids) x) d;
  if coalesce(cardinality(v_sorted), 0) = 0 or cardinality(v_sorted) <> cardinality(p_request_ids) then
    raise exception 'freed_option_invalid' using errcode = 'P0001';
  end if;
  -- the set must be one of the listed options (an offer made before options existed: any one candidate)
  if not exists (select 1 from jsonb_array_elements(v_offer.options) o
                 where (select array_agg(x::uuid order by x::uuid) from jsonb_array_elements_text(o -> 'request_ids') x) = v_sorted)
     and not (jsonb_array_length(v_offer.options) = 0 and cardinality(v_sorted) = 1
              and exists (select 1 from public.freed_slot_claims c where c.offer_id = p_offer_id and c.request_id = v_sorted[1])) then
    raise exception 'freed_option_invalid' using errcode = 'P0001';
  end if;
  if exists (select 1 from public.freed_slot_claims c where c.offer_id = p_offer_id and c.request_id = any(v_sorted) and c.status = 'withdrawn') then
    raise exception 'freed_candidate_stepped_out' using errcode = 'P0001';
  end if;

  -- REQ §13.168: someone who already has a car (not by plan B) is no longer a candidate
  if exists (select 1 from public.requests q where q.id = any(v_sorted) and q.status in ('assigned', 'merged') and not q.served_by_alternative) then
    raise exception 'freed_candidate_placed' using errcode = 'P0001';
  end if;
  perform set_config('app.audit_reason', 'award_freed_option', true);
  for r in
    select q.id, q.requester_id, q.served_by_alternative as plan_b,
      coalesce(case when q.served_by_alternative then (a.original_main ->> 'depart_at')::timestamptz end, q.depart_at) as dep
    from public.requests q left join public.request_alternatives a on a.request_id = q.id
    where q.id = any(v_sorted) order by 4, q.id
  loop
    v_ride := public.place_freed_slot_request(p_offer_id, r.id, v_actor, 'FREED_SLOT_APPROVED');
    v_first := coalesce(v_first, r.id);
    v_rides := v_rides || jsonb_build_array(jsonb_build_object('request_id', r.id, 'ride_id', v_ride));
    perform public.enqueue_notification(r.requester_id, 'claim_approved', v_offer.department_id, v_offer.week_start, '{}'::jsonb,
      jsonb_strip_nulls(jsonb_build_object('ride_id', v_ride, 'request_id', r.id, 'variant', case when r.plan_b then 'from_plan_b' end)),
      format('claim_approved:%s', r.id));
  end loop;

  update public.freed_slot_claims set status = 'approved', decided_at = v_now, decided_by = v_actor
  where offer_id = p_offer_id and request_id = any(v_sorted);
  update public.freed_slot_claims set status = 'declined', decided_at = v_now, decided_by = v_actor
  where offer_id = p_offer_id and request_id <> all(v_sorted) and status in ('offered', 'claimed');
  update public.freed_slot_offers set status = 'approved', resolved_at = v_now, resolved_by = v_actor, winning_request_id = v_first
  where id = p_offer_id;

  perform public.enqueue_notification(fc.profile_id, 'claim_declined', v_offer.department_id, v_offer.week_start, '{}'::jsonb,
    jsonb_strip_nulls(jsonb_build_object('offer_id', p_offer_id, 'request_id', fc.request_id, 'variant', case when q.served_by_alternative then 'plan_b_kept' end)),
    format('claim_declined:%s:%s', p_offer_id, fc.profile_id))
  from public.freed_slot_claims fc join public.requests q on q.id = fc.request_id
  where fc.offer_id = p_offer_id and fc.status = 'declined' and fc.decided_at = v_now;

  return jsonb_build_object('offer_id', p_offer_id, 'rides', v_rides);
end $$;

create or replace function public.discuss_freed_candidates(p_offer_id uuid, p_request_ids uuid[])
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare v_offer public.freed_slot_offers%rowtype; v_actor uuid := (select auth.uid()); v_group uuid; v_ids uuid[];
  g record; m record; v_car text; v_now timestamptz := now();
begin
  select * into v_offer from public.freed_slot_offers where id = p_offer_id for update;
  if v_offer.id is null then raise exception 'offer_not_found' using errcode = 'P0001'; end if;
  if not public.can_manage_week(v_offer.department_id, v_offer.week_start) then raise exception 'not_authorized' using errcode = 'P0001'; end if;
  if v_offer.status <> 'pending_approval' then raise exception 'offer_not_open' using errcode = 'P0001'; end if;
  select array_agg(distinct x) into v_ids from unnest(p_request_ids) x;
  if coalesce(cardinality(v_ids), 0) < 2 or cardinality(v_ids) <> cardinality(p_request_ids)
     or exists (select 1 from unnest(v_ids) rid where not exists (
          select 1 from public.freed_slot_claims c where c.offer_id = p_offer_id and c.request_id = rid and c.status in ('offered', 'claimed')))
     or exists (select 1 from public.waitlist_group_members wm join public.waitlist_groups wg on wg.id = wm.group_id
                where wm.request_id = any(v_ids) and wm.chosen is null and wg.status = 'open') then
    raise exception 'freed_discussion_invalid' using errcode = 'P0001';
  end if;

  -- REQ §13.168: someone who already has a car (not by plan B) is no longer a candidate
  if exists (select 1 from public.requests q where q.id = any(v_ids) and q.status in ('assigned', 'merged') and not q.served_by_alternative) then
    raise exception 'freed_candidate_placed' using errcode = 'P0001';
  end if;
  perform set_config('app.audit_reason', 'discuss_freed_candidates', true);
  v_group := public.create_waitlist_group(v_offer.department_id, v_offer.week_start,
    (v_offer.starts_at at time zone 'Asia/Jerusalem')::date, v_ids);
  if v_group is null then raise exception 'freed_discussion_invalid' using errcode = 'P0001'; end if;
  -- the offer holds the car for that group again (settle_waitlist_group takes it first)
  update public.freed_slot_offers set status = 'open', group_id = v_group, resolved_by = v_actor where id = p_offer_id;
  update public.freed_slot_claims set status = 'declined', decided_at = v_now, decided_by = v_actor
  where offer_id = p_offer_id and request_id <> all(v_ids) and status in ('offered', 'claimed');

  select * into g from public.waitlist_groups where id = v_group;
  select name into v_car from public.cars where id = v_offer.car_id;
  for m in select wm.request_id, wm.profile_id from public.waitlist_group_members wm where wm.group_id = v_group order by wm.created_at, wm.id loop
    perform public.enqueue_notification(m.profile_id, 'waitlist_contested', g.department_id, g.week_start,
      jsonb_build_object('car', coalesce(v_car, ''), 'day', public.day_date_label(g.starts_at),
        'depart', to_char(g.starts_at at time zone 'Asia/Jerusalem', 'HH24:MI'), 'return', to_char(g.ends_at at time zone 'Asia/Jerusalem', 'HH24:MI')),
      jsonb_build_object('group_id', v_group, 'request_id', m.request_id, 'day', g.day::text, 'variant', 'car_freed'),
      format('waitlist_car_freed:%s:%s:%s', v_group, p_offer_id, m.profile_id));
  end loop;
  perform public.enqueue_notification(fc.profile_id, 'claim_declined', v_offer.department_id, v_offer.week_start, '{}'::jsonb,
    jsonb_strip_nulls(jsonb_build_object('offer_id', p_offer_id, 'request_id', fc.request_id, 'variant', case when q.served_by_alternative then 'plan_b_kept' end)),
    format('claim_declined:%s:%s', p_offer_id, fc.profile_id))
  from public.freed_slot_claims fc join public.requests q on q.id = fc.request_id
  where fc.offer_id = p_offer_id and fc.status = 'declined' and fc.decided_at = v_now;
  return v_group;
end $$;

create or replace function public.requests_leave_freed_offers()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  -- REQ §13.168: a request that got a car (not by plan B) is no candidate on any other pending freed car
  update public.freed_slot_claims c set status = 'declined', decided_at = now()
  where c.request_id = new.id and c.status in ('offered', 'claimed')
    and exists (select 1 from public.freed_slot_offers o where o.id = c.offer_id and o.status in ('open', 'pending_approval'));
  return null;
end $$;

revoke all on function public.requests_leave_freed_offers() from public;

create trigger requests_leave_freed_offers after update of status on public.requests
  for each row when (new.status in ('assigned', 'merged') and old.status is distinct from new.status and not new.served_by_alternative)
  execute function public.requests_leave_freed_offers();
