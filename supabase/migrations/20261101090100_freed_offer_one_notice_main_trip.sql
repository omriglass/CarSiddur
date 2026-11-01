-- QA run 17 (2026-11-01), REQ §13.168:
-- R17B3: a plan-B candidate's "a car was freed" notice named the plan B's drop place and hours; it names the main trip now.
-- R17B4: two cars freed together sent each candidate one notice per car; an unread one is folded into the next, which
-- names every car still being decided for that request, and its push replaces the earlier one (tag replace:freed_slot:<request>).
-- R17B5: a candidate who stepped out stays out when the car is ranked again; a candidate already told is not told again;
-- refresh_freed_offer lets the Sadran rank a waiting car again (new waiting-list requests since it was freed).
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

create or replace function public.refresh_freed_offer(p_offer_id uuid) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare o public.freed_slot_offers%rowtype;
begin
  select * into o from public.freed_slot_offers where id = p_offer_id for update;
  if not found then raise exception 'offer_not_found'; end if;
  if not public.can_manage_week(o.department_id, o.week_start) then raise exception 'not_authorized'; end if;
  if o.status <> 'pending_approval' then raise exception 'offer_not_pending'; end if;
  update public.freed_slot_offers set status = 'open', options = '[]'::jsonb where id = p_offer_id;
  perform public.invoke_on_ride_cancelled(p_offer_id);
end $$;
revoke all on function public.refresh_freed_offer(uuid) from public;
grant execute on function public.refresh_freed_offer(uuid) to authenticated;
